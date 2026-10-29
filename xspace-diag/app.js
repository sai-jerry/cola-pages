/* X空间 · 知识点前置诊断 前端 */
(function () {
  'use strict';
  var E = window.XKGraph;
  var LS_KEY = 'xsDiag.v1';          // 会被拼上学科，实际 key 形如 xsDiag.v1:chemistry
  var LS_SUBJECT = 'xsDiag.subject';

  /* ---------------------------------------------------------- 学科
   * 三科共用一套前端。数据在 data/<学科>/，图片统一在 assets/q/。
   * 学科由三级决定：URL 的 ?subject= 参数 → 上次选的（localStorage）→ 默认数学。
   * 答题存档的 key 也带学科，不然物理答到一半切到化学会把存档串了。
   */
  var SUBJECTS = [
    { id: 'math', name: '数学' },
    { id: 'physics', name: '物理' },
    { id: 'chemistry', name: '化学' }
  ];
  var SUBJECT = 'math';

  function subjectIds() {
    return SUBJECTS.map(function (s) { return s.id; });
  }
  function storeKey() { return LS_KEY + ':' + SUBJECT; }
  function dataPath(name) { return 'data/' + SUBJECT + '/' + name; }

  var graph = null;
  var state = {
    student: '',
    targets: [],
    session: null,
    summary: null,
    log: [],            // [{topicId, qid, text, verdict, result}]
    picked: null,       // 选择题当前选中
    awaiting: false,    // 已提交、等下一题
    demo: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* ------------------------------------------------------------ 题干里的图
   * 化学这类科目，实验操作题就是「四个图选一个」，图是题干的一部分。
   * 题库里这样写：prompt = "下列实验操作正确的是（　　）"，choices = ["{{fig:1}}", ...]
   * 这里把 {{fig:N}} 换成 <img>，其余文字一律走 esc。
   *
   * 给 img 写上 width/height 是为了让浏览器先占位，图片加载时页面不跳。
   * 实际显示多大由 CSS 管（.q-fig 和 .choice 里的 img 分开定）。
   */
  function figIndex(figs) {
    var map = {};
    (figs || []).forEach(function (f) { map[f.n] = f; });
    return map;
  }

  function richText(s, figs, cls) {
    var text = String(s == null ? '' : s);
    var map = figIndex(figs);
    if (!/\{\{fig:\d+\}\}/.test(text)) return esc(text);
    return text.split(/(\{\{fig:\d+\}\})/).map(function (part) {
      var m = /^\{\{fig:(\d+)\}\}$/.exec(part);
      if (!m) return esc(part);
      var f = map[+m[1]];
      if (!f) return '<span class="fig-missing">[缺图 ' + esc(m[1]) + ']</span>';
      return '<img class="q-fig ' + (cls || '') + '" src="' + esc(f.src) + '"' +
        (f.w ? ' width="' + f.w + '"' : '') +
        (f.h ? ' height="' + f.h + '"' : '') +
        ' alt="' + esc(f.alt || ('图 ' + f.n)) + '" loading="lazy">';
    }).join('');
  }


  /* ------------------------------------------------------------ 数据加载 */
  function loadJSON(name) {
    return fetch(dataPath(name), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('读取 ' + dataPath(name) + ' 失败');
      return r.json();
    });
  }

  function boot() {
    return Promise.all([loadJSON('topics.json'), loadJSON('dependencies.json'), loadJSON('questions.json')])
      .then(function (res) {
        graph = E.buildGraph(res[0], res[1], res[2]);
        renderScope();
        restore();
      })
      .catch(function (err) {
        $('start-hint').innerHTML = '<b>数据没加载出来：' + esc(err.message) +
          '</b><br>页面必须通过服务器打开（不能双击 html 文件）：在本目录运行 <code>python3 -m http.server 8000</code>，再访问 http://localhost:8000/';
      });
  }

  /* ------------------------------------------------------------ 选范围 */
  function chapterKey(chapter) {
    var parts = String(chapter).split(' ');
    return parts.length >= 3 ? parts.slice(0, 3).join(' ') : chapter;
  }

  function chapterGroups() {
    var groups = [];
    var index = {};
    graph.topics.forEach(function (t) {
      var key = chapterKey(t.chapter);
      if (!index[key]) { index[key] = { chapter: key, topics: [] }; groups.push(index[key]); }
      index[key].topics.push(t);
    });
    return groups;
  }

  function renderScope() {
    var host = $('scope-list');
    host.innerHTML = '';
    chapterGroups().forEach(function (g) {
      var wrap = document.createElement('div');
      wrap.className = 'scope-group open';
      var head = document.createElement('div');
      head.className = 'scope-group-head';
      head.innerHTML = '<span class="ch">' + esc(g.chapter) + '</span>' +
        '<span class="cnt">' + g.topics.length + ' 个知识点</span>' +
        '<button class="ghost" style="margin-left:auto;padding:5px 12px;font-size:12px">整章诊断</button>';
      var items = document.createElement('div');
      items.className = 'scope-items';
      g.topics.forEach(function (t) {
        var b = document.createElement('button');
        b.className = 'scope-item' + (state.targets.indexOf(t.id) >= 0 ? ' on' : '');
        b.textContent = t.name;
        b.dataset.id = t.id;
        b.onclick = function (ev) {
          ev.stopPropagation();
          state.targets = [t.id];
          syncScope();
        };
        items.appendChild(b);
      });
      head.querySelector('button').onclick = function (ev) {
        ev.stopPropagation();
        state.targets = g.topics.map(function (t) { return t.id; });
        syncScope();
      };
      head.onclick = function () { wrap.classList.toggle('open'); };
      wrap.appendChild(head);
      wrap.appendChild(items);
      host.appendChild(wrap);
    });
  }

  function syncScope() {
    Array.prototype.forEach.call(document.querySelectorAll('.scope-item'), function (b) {
      b.classList.toggle('on', state.targets.indexOf(b.dataset.id) >= 0);
    });
    var n = state.targets.length;
    $('btn-start').disabled = n === 0;
    $('start-hint').textContent = n === 0 ? '先在上面选一个范围。'
      : n === 1 ? '已选：' + graph.byId[state.targets[0]].name
        : '已选整章：' + n + ' 个知识点（按册筛查）';
  }

  /* ------------------------------------------------------------ 会话 */
  function newSession(targets, limit, seed) {
    return E.createSession(graph, targets, { limit: limit, seed: seed || 'stu' });
  }

  function replay(answers) {
    var s = newSession(state.targets, state.limit, state.seed);
    answers.forEach(function (a) { s = E.applyAnswer(graph, s, a.topicId, a.result); });
    return s;
  }

  function start(targets, limit, demo) {
    state.targets = targets.slice();
    state.limit = limit;
    state.demo = !!demo;
    state.seed = demo ? 'demo' : String(Date.now());
    state.log = [];
    state.session = newSession(state.targets, limit, state.seed);
    state.summary = null;
    show('quiz');
    renderQuestion();
  }

  /* ------------------------------------------------------------ 出题 */
  function whyText(topicId, nth) {
    if (state.session.targets.indexOf(topicId) >= 0) return nth > 1 ? '目标本人 · 第 1 题没过，再确认一道' : '目标知识点';
    if (nth > 1) return '第 1 题没过，再确认一道';
    var from = graph.dependents[topicId].filter(function (d) {
      return E.statusOf(state.session, d.id) === 'weak';
    })[0];
    return from ? '因为「' + graph.byId[from.id].name + '」两题都没过，往回追先修' : '沿先修回溯';
  }

  function renderQuestion() {
    var cur = E.currentQuestion(graph, state.session);
    if (!cur) { finish(); return; }
    state.picked = null;
    state.awaiting = false;
    state.pending = null;
    $('answer-input').disabled = false;
    setQuizMsg('');

    var t = graph.byId[cur.topicId];
    var q = cur.question;
    $('q-topic').textContent = t.name;
    $('q-why').textContent = whyText(cur.topicId, cur.nth);
    $('q-diff').textContent = { basic: '基础', standard: '标准', advanced: '提高' }[q.difficulty] || q.difficulty;
    $('q-prompt').innerHTML = richText(q.prompt, q.figures);

    var answered = state.session.answers.length;
    var limit = state.session.limit;
    $('progress-bar').style.width = Math.min(100, Math.round(answered / limit * 100)) + '%';
    $('progress-text').textContent = '第 ' + (answered + 1) + ' 题 / 上限 ' + limit + ' 题';

    var choices = $('q-choices');
    choices.innerHTML = '';
    var inputWrap = $('q-input');
    var answerInput = $('answer-input');
    var submit = $('btn-submit');
    $('feedback').hidden = true;

    if (q.type === 'choice') {
      inputWrap.hidden = false;
      answerInput.hidden = true;
      $('input-label').hidden = true;
      submit.hidden = false;
      // 每个选项都带图就切两列，省一半高度
      var allFig = q.choices.every(function (c) {
        return /\{\{fig:\d+\}\}/.test(c.text);
      });
      choices.className = allFig ? 'choices all-fig' : 'choices';
      q.choices.forEach(function (c) {
        var b = document.createElement('button');
        b.className = 'choice';
        b.innerHTML = '<span class="key">' + esc(c.key) + '</span><span class="opt-body">' +
          richText(c.text, q.figures, 'opt-fig') + '</span>';
        b.onclick = function () {
          if (state.awaiting) return;
          state.picked = c.text;
          Array.prototype.forEach.call(choices.children, function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        };
        choices.appendChild(b);
      });
    } else {
      inputWrap.hidden = false;
      answerInput.hidden = false;
      $('input-label').hidden = false;
      submit.hidden = false;
      answerInput.value = '';
      answerInput.focus();
    }
    $('btn-next').hidden = true;
    syncUndo();
  }

  function syncUndo() {
    $('btn-undo').disabled = state.log.length === 0;
    $('btn-finish').textContent = state.log.length ? '提前结束，看结果' : '退出';
  }

  /* ------------------------------------------------------------ 判题 */
  function submitAnswer() {
    if (state.awaiting) return;
    var cur = E.currentQuestion(graph, state.session);
    if (!cur) return;
    var q = cur.question;
    var text = q.type === 'choice' ? state.picked : $('answer-input').value;
    if (q.type === 'choice' && !text) { flash('先选一个选项。'); return; }
    if (q.type !== 'choice' && !String(text || '').trim()) { flash('先填答案。'); return; }

    var judged = E.judgeQuestion(q, text);
    showFeedback(cur, q, text, judged);
  }

  function showFeedback(cur, q, text, judged) {
    state.awaiting = true;
    state.pending = { cur: cur, q: q, text: text };
    $('feedback').hidden = false;
    var v = $('feedback-verdict');
    v.className = 'verdict ' + judged.verdict;
    v.textContent = judged.verdict === 'correct' ? '✓ 答对了' : judged.verdict === 'wrong' ? '✗ 没答对' : '？需要老师看一眼';
    $('feedback-answer').textContent = q.answer;
    $('feedback-explain').textContent = q.explanation;
    $('manual-ask').hidden = judged.verdict !== 'manual';
    $('btn-next').hidden = judged.verdict === 'manual';
    $('btn-submit').hidden = true;
    $('answer-input').disabled = true;
    Array.prototype.forEach.call($('q-choices').children, function (b) { b.disabled = true; });

    if (judged.verdict !== 'manual') record(cur, q, text, judged.verdict);
  }

  function record(cur, q, text, result) {
    state.log.push({ topicId: cur.topicId, qid: q.id, text: text, result: result });
    state.session = E.applyAnswer(graph, state.session, cur.topicId, result);
    save();
  }

  function manualPick(result) {
    if (!state.pending) return;
    var cur = state.pending.cur, q = state.pending.q, text = state.pending.text;
    record(cur, q, text, result);
    state.pending = null;
    $('manual-ask').hidden = true;
    $('btn-next').hidden = false;
    var v = $('feedback-verdict');
    v.className = 'verdict ' + (result === 'correct' ? 'correct' : 'wrong');
    v.textContent = result === 'correct' ? '✓ 老师判定：算过' : '✗ 老师判定：没过';
  }

  function next() {
    renderQuestion();
    if (!E.currentQuestion(graph, state.session)) finish();
  }

  function undo() {
    if (!state.log.length) return;
    state.log.pop();
    state.session = replay(state.log);
    state.awaiting = false;
    $('answer-input').disabled = false;
    show('quiz');
    renderQuestion();
    save();
  }

  function setQuizMsg(msg) {
    var el = $('quiz-msg');
    if (!el) {
      el = document.createElement('p');
      el.id = 'quiz-msg';
      el.className = 'hint';
      el.style.margin = '10px 0 0';
      $('q-input').parentNode.insertBefore(el, $('feedback'));
    }
    el.textContent = msg || '';
  }

  function flash(msg) { setQuizMsg(msg); }

  /* ------------------------------------------------------------ 结果 */
  function finish() {
    state.summary = E.summarize(graph, state.session);
    renderResult();
    show('result');
    save();
  }

  function renderResult() {
    var s = state.summary, c = s.counts;
    var scopeNames = state.targets.map(function (id) { return graph.byId[id].name; });
    $('result-scope').textContent = '诊断范围：' + (scopeNames.length > 3 ? scopeNames.length + ' 个知识点（整章）' : scopeNames.join('、')) +
      '　已问 ' + state.session.answers.length + ' 题' + (state.demo ? '　【演示数据】' : '');

    $('stats').innerHTML = [
      ['mastered', c.mastered, '掌握'],
      ['shaky', c.shaky, '不稳'],
      ['weak', c.weak, '薄弱'],
      ['', c.untested, '未测']
    ].map(function (x) {
      return '<div class="stat ' + x[0] + '"><b>' + x[1] + '</b><span>' + x[2] + '</span></div>';
    }).join('');

    var roots = s.roots.length ? s.roots : [];
    $('roots').innerHTML = roots.length ? roots.map(function (id) {
      var t = graph.byId[id];
      return '<div class="root-item"><b>' + esc(t.name) + '</b>　<span class="hint">' + esc(t.chapter) + '</span>' +
        '<p>' + esc(t.mastery.join('；')) + '</p></div>';
    }).join('') : '<p class="hint">没有找到更早的缺口——问题就在目标知识点本身，或者这次答题没问到点上。</p>';

    $('shaky').innerHTML = s.shaky.length ? s.shaky.map(function (id) {
      var t = graph.byId[id];
      return '<div class="root-item shaky"><b>' + esc(t.name) + '</b>　<span class="hint">一错一对，会但不稳</span></div>';
    }).join('') : '<p class="hint">无。</p>';

    $('path').innerHTML = s.path.length ? s.path.map(function (id) {
      var t = graph.byId[id];
      var st = E.statusOf(state.session, id);
      var label = st === 'weak' ? '薄弱' : st === 'shaky' ? '不稳' : '未测';
      return '<li><span class="g">' + esc(t.chapter.split(' ')[0]) + '</span>' + esc(t.name) +
        '<span class="tag ' + st + '">' + label + '</span></li>';
    }).join('') : '<li class="hint">无需补课的点。</li>';

    buildReport();
  }

  /* ------------------------------------------------------------ 一页纸报告 */
  function buildReport() {
    var s = state.summary, c = s.counts;
    var scopeNames = state.targets.map(function (id) { return graph.byId[id].name; });
    var hours = E.suggestHours(c);

    $('report-student').textContent = state.student || '—';
    $('report-date').textContent = new Date().toLocaleDateString('zh-CN');
    $('report-scope').textContent = '范围：' + (scopeNames.length > 3 ? scopeNames.length + ' 个知识点（整章）' : scopeNames.join('、')) +
      '　|　题量：' + state.session.answers.length + ' 题' + (state.demo ? '（演示数据）' : '');

    $('report-summary-note').textContent =
      '本次沿先修关系共扫描 ' + c.total + ' 个知识点（含答对后推断掌握的先修），下表按知识点个数统计。';
    $('report-stats').innerHTML = [
      ['掌握', c.mastered], ['不稳', c.shaky], ['薄弱', c.weak], ['未测', c.untested]
    ].map(function (x) { return '<tr><td>' + x[0] + '</td><td>' + x[1] + ' 个</td><td>' + x[0] + '占比</td><td>' +
      (c.total ? Math.round(x[1] / c.total * 100) : 0) + '%</td></tr>'; }).join('');

    $('report-roots').innerHTML = s.roots.length ? s.roots.map(function (id) {
      var t = graph.byId[id];
      return '<li><b>' + esc(t.name) + '</b>（' + esc(t.chapter) + '）：' + esc(t.mastery.join('；')) + '</li>';
    }).join('') : '<li>本次未发现更早的知识缺口。</li>';

    var RANK = { weak: 0, shaky: 1, untested: 2 };
    function fmtStatus(id) {
      var st = E.statusOf(state.session, id);
      return st === 'weak' ? '薄弱' : st === 'shaky' ? '不稳' : '未测';
    }
    if (!s.path.length) {
      $('report-path').innerHTML = '<tr><td colspan="4">无需补课的点。</td></tr>';
    } else if (s.path.length > 10) {
      // 缺口太多时按章合并：一页纸装不下十几个点的逐条清单，家长也读不完
      var order = [], gidx = {};
      s.path.forEach(function (id) {
        var t = graph.byId[id];
        var key = t.chapter.split(' ').slice(0, 3).join(' ');
        if (!gidx[key]) { gidx[key] = { chapter: key, names: [], weak: 0 }; order.push(gidx[key]); }
        var g = gidx[key];
        g.names.push(t.name);
        if (E.statusOf(state.session, id) === 'weak') g.weak++;
      });
      var perHour = Math.max(0.5, s.hours / s.path.length);
      $('report-path').innerHTML = order.map(function (g, i) {
        var h = Math.max(1, Math.round(g.names.length * perHour));
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(g.chapter) + '</td><td>' +
          esc(g.names.join('、')) + '</td><td>' + h + ' 课时</td></tr>';
      }).join('');
    } else {
      $('report-path').innerHTML = s.path.map(function (id, i) {
        var t = graph.byId[id];
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(t.chapter.split(' ').slice(0, 3).join(' ')) +
          '</td><td>' + esc(t.name) + '</td><td>' + fmtStatus(id) + '</td></tr>';
      }).join('');
    }

    var wrongAll = state.log.filter(function (a) { return a.result === 'wrong'; });
    var wrongCap = s.path.length > 12 ? 3 : 6;   // 路径长时少列错题，尽量压在一页
    var wrongRows = wrongAll.slice(0, wrongCap).map(function (a, i) {
      var q = null;
      (graph.questionsByTopic[a.topicId] || []).forEach(function (x) { if (x.id === a.qid) q = x; });
      if (!q) return '';
      // 错题复核这一列要带图——老师拿着纸对错题时，没有图等于没给
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(graph.byId[a.topicId].name) + '</td><td>' +
        richText(q.prompt, q.figures, 'rep-fig') +
        (a.text ? '<br><i>学生答案：' + richText(a.text, q.figures, 'rep-fig') + '</i>' : '') +
        '</td><td>' + richText(q.answer, q.figures, 'rep-fig') + '</td><td></td></tr>';
    }).join('');
    if (wrongRows && wrongAll.length > 6) {
      wrongRows += '<tr><td colspan="5">…另有 ' + (wrongAll.length - 8) + ' 道错题未列出，完整答题记录已随本次诊断一起导出。</td></tr>';
    }
    $('report-wrong').innerHTML = wrongRows || '<tr><td colspan="5">本次没有答错的题。</td></tr>';

    // 天津中考考情：本次范围里挂有 exam 数据的知识点，按年份合并去重
    var examMap = {};
    (state.targets || []).forEach(function (id) {
      var t = graph.byId[id];
      if (!t || !t.exam) return;
      t.exam.forEach(function (e) {
        var k = e.year + '|' + e.score;
        if (!examMap[k]) examMap[k] = { year: e.year, score: e.score, whats: [] };
        if (examMap[k].whats.indexOf(e.what) < 0) examMap[k].whats.push(e.what);
      });
    });
    var examList = Object.keys(examMap).map(function (k) { return examMap[k]; })
      .sort(function (a, b) { return parseInt(a.year, 10) - parseInt(b.year, 10); });
    if (examList.length) {
      $('report-exam-block').hidden = false;
      var scoreSet = {};
      examList.forEach(function (e) { scoreSet[e.score] = 1; });
      var scoreKeys = Object.keys(scoreSet);
      $('report-exam-note').textContent = scoreKeys.length === 1
        ? '近 ' + examList.length + ' 年天津卷考法稳定：' + scoreKeys[0] + '。'
        : '近 ' + examList.length + ' 年天津卷的考法见下表。';
      $('report-exam').innerHTML = examList.map(function (e) {
        return '<li><b>' + esc(e.year) + '</b>　' + esc(e.score) + '　' + esc(e.whats.join('；')) + '</li>';
      }).join('');
    } else {
      $('report-exam-block').hidden = true;
    }

    renumberReport();

    $('report-plan').textContent = hours
      ? '建议按上表顺序补课，先修在前，共约 ' + hours + ' 课时；每节课后用同一知识点复测两题，两题都过即可结课。'
      : '本次未发现需要补的知识点，可进入下一章或提高难度的题组。';
  }

  /* 报告里的小节编号是写死的「一、二、三…」，但某些小节会被 hide（
     比如分式章没有中考考情实证，第四节整块不显示）。
     这里按实际可见的小节重排一遍，避免出现「三、」直接跳到「五、」。 */
  function renumberReport() {
    var CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    var blocks = [].slice.call(document.querySelectorAll('#report .report-block'))
      .filter(function (b) { return !b.hidden; });
    blocks.forEach(function (b, i) {
      var h = b.querySelector('h2');
      if (!h) return;
      h.textContent = h.textContent.replace(/^[一二三四五六七八九十]+、/, CN[i] + '、');
    });
  }

  /* ------------------------------------------------------------ 屏幕切换 */
  function show(which) {
    ['start', 'quiz', 'result'].forEach(function (k) {
      $('screen-' + k).hidden = (k !== which);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.classList.toggle('active', b.dataset.go === which);
    });
    var tabs = document.querySelectorAll('.tabs button');
    tabs[0].disabled = false;
    tabs[1].disabled = !state.session;
    tabs[2].disabled = !state.summary;
    if (which === 'result') { $('report').hidden = false; }
  }

  /* ------------------------------------------------------------ 存档 */
  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({
        student: state.student, targets: state.targets, limit: state.limit, seed: state.seed,
        log: state.log, demo: state.demo, done: !!state.summary
      }));
    } catch (e) { /* 隐私模式下存不了就算了 */ }
  }

  function restore() {
    var raw;
    try { raw = localStorage.getItem(storeKey()); } catch (e) { raw = null; }
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      if (!d.log || !d.log.length || !d.targets) return;
      state.targets = d.targets;
      state.limit = d.limit || 16;
      state.seed = d.seed;
      state.student = d.student || '';
      state.demo = !!d.demo;
      $('student').value = state.student;
      $('limit').value = d.limit;
      syncScope();
      var btn = $('btn-resume');
      btn.hidden = false;
      btn.textContent = '继续上次（已答 ' + d.log.length + ' 题）';
      btn.onclick = function () {
        state.log = d.log;
        state.session = replay(d.log);
        if (d.done) { finish(); } else { show('quiz'); renderQuestion(); }
      };
    } catch (e) { /* 存档坏了就当没有 */ }
  }

  /* ---------------------------------------------------------- 科目配置
     数学和物理共用这一套界面，靠 data/meta.json 区分文案与演示路径。
     没有 meta.json 时（比如只拷了四件套没拷 data）就退回数学那套默认值。 */
  var DEMO_PLAN = { xs_qf_04: ['wrong', 'wrong'], xs_qf_03: ['wrong', 'correct'], xs_pre_04: ['wrong', 'wrong'] };
  var DEMO_TARGET = 'xs_qf_04';
  var DEMO_PLAN_DEFAULT = DEMO_PLAN;
  var DEMO_TARGET_DEFAULT = DEMO_TARGET;

  function applyMeta(m) {
    // 换学科时先把上一科的值抹掉，不然切到数学还会带着化学的演示路径
    DEMO_PLAN = DEMO_PLAN_DEFAULT;
    DEMO_TARGET = DEMO_TARGET_DEFAULT;
    document.title = 'X空间 · 知识点前置诊断';
    var sub = document.getElementById('brand-sub');
    if (sub) sub.textContent = '知识点前置诊断';
    var hint = document.getElementById('subject-note');
    if (hint) hint.hidden = true;
    if (!m) return;
    if (m.title) document.title = m.title;
    if (sub && m.subtitle) sub.textContent = m.subtitle;
    if (hint && m.note) { hint.textContent = m.note; hint.hidden = false; }
    if (m.demoPlan) DEMO_PLAN = m.demoPlan;
    if (m.demoTarget) DEMO_TARGET = m.demoTarget;
  }

  /* ---------------------------------------------------------- 学科切换 */
  function renderSubjTabs() {
    var host = $('subject-tabs');
    if (!host) return;
    host.innerHTML = '';
    SUBJECTS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'subject-tab' + (s.id === SUBJECT ? ' active' : '');
      b.textContent = s.name;
      b.dataset.subject = s.id;
      b.onclick = function () {
        if (s.id === SUBJECT || b.disabled) return;
        switchSubject(s.id);
      };
      host.appendChild(b);
    });
  }

  function resetState() {
    state.targets = [];
    state.session = null;
    state.summary = null;
    state.log = [];
    state.picked = null;
    state.awaiting = false;
    state.demo = false;
    $('report').hidden = true;
    $('btn-resume').hidden = true;
    $('btn-start').disabled = true;
    $('scope-list').innerHTML = '';
    $('start-hint').textContent = '先在上面选一个范围。';
  }

  function switchSubject(id) {
    resetState();
    show('start');
    return loadSubject(id);
  }

  function loadSubject(id) {
    SUBJECT = id;
    saveSubjectChoice(id);
    renderSubjTabs();
    var u = new URL(location.href);
    if (u.searchParams.get('subject') !== id) {
      u.searchParams.set('subject', id);
      history.replaceState(null, '', u.toString());
    }
    return fetch(dataPath('meta.json'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(applyMeta)
      .catch(function () { applyMeta(null); })
      .then(boot);
  }

  function saveSubjectChoice(id) {
    try { localStorage.setItem(LS_SUBJECT, id); } catch (e) { /* 隐私模式 */ }
  }

  function initialSubject() {
    var want = new URLSearchParams(location.search).get('subject');
    if (!want) { try { want = localStorage.getItem(LS_SUBJECT); } catch (e) { want = null; } }
    return subjectIds().indexOf(want) >= 0 ? want : 'math';
  }

  /* ------------------------------------------------------------ 事件绑定 */
  document.addEventListener('DOMContentLoaded', function () {
    $('student').oninput = function () { state.student = this.value.trim(); };
    $('limit').oninput = function () { state.limit = parseInt(this.value, 10) || 16; };

    $('btn-start').onclick = function () {
      if (!state.targets.length) return;
      var limit = Math.max(4, Math.min(60, parseInt($('limit').value, 10) || 16));
      state.student = $('student').value.trim();
      start(state.targets, limit, false);
    };

    $('btn-demo').onclick = function () {
      // 演示：目标两题都错 -> 往回追；顶点式一错一对（不稳）；完全平方公式两题都错（真正的根因）
      var plan = DEMO_PLAN;
      var seen = {};
      state.student = '';
      state.targets = [DEMO_TARGET];
      state.limit = 16;
      state.demo = true;
      state.seed = 'demo';
      state.log = [];
      var s = newSession(state.targets, 16, 'demo');
      var seq = [];
      for (var i = 0; i < 60; i++) {
        var cur = E.currentQuestion(graph, s);
        if (!cur) break;
        var key = cur.topicId;
        var want = plan[key] || ['correct'];
        var k = seen[key] || 0;
        seen[key] = k + 1;
        var res = want[Math.min(k, want.length - 1)];
        seq.push({ topicId: key, qid: cur.question.id, text: '', result: res });
        s = E.applyAnswer(graph, s, key, res);
      }
      state.log = seq;
      state.session = s;
      finish();
    };

    $('btn-submit').onclick = submitAnswer;
    $('answer-input').onkeydown = function (e) { if (e.key === 'Enter') submitAnswer(); };
    $('btn-next').onclick = next;
    $('btn-undo').onclick = undo;
    $('btn-finish').onclick = function () { if (state.log.length) finish(); else show('start'); };
    Array.prototype.forEach.call(document.querySelectorAll('#manual-ask button'), function (b) {
      b.onclick = function () { manualPick(b.dataset.manual); };
    });

    $('btn-print').onclick = function () { window.print(); };
    $('btn-restart').onclick = function () {
      state.log = []; state.session = null; state.summary = null;
      $('report').hidden = true;
      try { localStorage.removeItem(storeKey()); } catch (e) {}
      show('start');
    };
    $('btn-export').onclick = function () {
      var payload = {
        student: state.student, date: new Date().toISOString(), range: state.targets,
        answers: state.log.map(function (a) {
          return { topicId: a.topicId, topic: graph.byId[a.topicId].name, qid: a.qid, result: a.result };
        }),
        summary: {
          mastered: state.summary.mastered, shaky: state.summary.shaky,
          weak: state.summary.weak, untested: state.summary.untested,
          roots: state.summary.roots, path: state.summary.path,
          hours: E.suggestHours(state.summary.counts)
        }
      };
      var blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'X空间诊断_' + (state.student || '学生') + '_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    };

    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.onclick = function () {
        if (b.disabled) return;
        show(b.dataset.go);
        if (b.dataset.go === 'quiz' && state.session) renderQuestion();
      };
    });

    loadSubject(initialSubject()).then(function () {
      var params = new URLSearchParams(location.search);
      if (params.get('demo') === 'chapter') {
        // 整章演示（用来检查报告在最长情况下是否还能一页装下）
        state.targets = graph.topics.filter(function (t) {
          return t.chapter.indexOf('九上') === 0;
        }).map(function (t) { return t.id; });
        state.limit = 40; state.demo = true; state.seed = 'chapterdemo'; state.log = [];
        var sc = newSession(state.targets, 40, 'chapterdemo');
        var sq = [];
        for (var j = 0; j < 80; j++) {
          var c2 = E.currentQuestion(graph, sc);
          if (!c2) break;
          sq.push({ topicId: c2.topicId, qid: c2.question.id, text: '', result: (j % 4 === 1 ? 'correct' : 'wrong') });
          sc = E.applyAnswer(graph, sc, c2.topicId, (j % 4 === 1 ? 'correct' : 'wrong'));
        }
        state.log = sq; state.session = sc; finish();
      }
      else if (params.get('demo') === '1') { $('btn-demo').click(); }
      else if (params.get('quiz') === '1') {
        state.targets = [params.get('target') || DEMO_TARGET];
        $('limit').value = 16;
        start(state.targets, 16, false);
      }
    });
  });
})();
