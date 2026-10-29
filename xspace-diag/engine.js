/*!
 * X空间 · 前置诊断引擎（自写实现，不依赖任何第三方库、不依赖原开源项目的代码）
 *
 * 设计目标：给出"这个孩子卡在哪一步"的证据链，而不是只判一道题的对错。
 * 判定规则（X空间口径，可调）：
 *   每个知识点最多问 2 题。
 *   第 1 题对            -> 这个点「掌握」，它的所有先修一并记为「掌握（推断）」，不再问。
 *   第 1 题错            -> 同一点再出第 2 题（同级或更容易）。
 *   第 2 题也对          -> 「不稳」：不进先修，但进学习路径作为要补的点。
 *   第 2 题也错          -> 「薄弱」：沿先修边往回走（hard 先于 soft）找根因。
 *
 * 纯函数、无 DOM，浏览器里挂 window.XKGraph，Node 里 require。
 * 会话对象可 JSON 序列化，可重放（同 seed + 同作答 = 同样结果）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XKGraph = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIFF_RANK = { basic: 0, standard: 1, advanced: 2 };
  var DEFAULT_LIMIT = 16;

  /* ----------------------------------------------------------- 图 */

  function buildGraph(topics, dependencies, questions) {
    var byId = Object.create(null);
    var order = Object.create(null);
    topics.forEach(function (t, i) { byId[t.id] = t; order[t.id] = i; });

    var prereqs = Object.create(null);
    var dependents = Object.create(null);
    topics.forEach(function (t) { prereqs[t.id] = []; dependents[t.id] = []; });

    var seen = Object.create(null);
    dependencies.forEach(function (d) {
      if (!byId[d.topicId] || !byId[d.prerequisiteId]) return;
      var key = d.topicId + '<' + d.prerequisiteId;
      if (seen[key]) return;
      seen[key] = true;
      var strength = d.strength === 'soft' ? 'soft' : 'hard';
      prereqs[d.topicId].push({ id: d.prerequisiteId, strength: strength, reason: d.reason || '' });
      dependents[d.prerequisiteId].push({ id: d.topicId, strength: strength });
    });
    // hard 先于 soft；同级按 topics.json 的顺序，保证结果稳定可复现
    Object.keys(prereqs).forEach(function (id) {
      prereqs[id].sort(function (a, b) {
        if (a.strength !== b.strength) return a.strength === 'hard' ? -1 : 1;
        return order[a.id] - order[b.id];
      });
    });

    var byTopic = Object.create(null);
    topics.forEach(function (t) { byTopic[t.id] = []; });
    (questions || []).forEach(function (q) {
      if (!byTopic[q.topicId]) return;
      byTopic[q.topicId].push(q);
    });
    Object.keys(byTopic).forEach(function (id) {
      byTopic[id].sort(function (a, b) {
        var d = (DIFF_RANK[a.difficulty] || 0) - (DIFF_RANK[b.difficulty] || 0);
        if (d) return d;
        return String(a.id) < String(b.id) ? -1 : 1;
      });
    });

    return {
      byId: byId, order: order, prereqs: prereqs, dependents: dependents,
      questionsByTopic: byTopic, topics: topics
    };
  }

  function ancestors(graph, id) {
    var out = Object.create(null);
    var stack = (graph.prereqs[id] || []).map(function (p) { return p.id; });
    while (stack.length) {
      var cur = stack.pop();
      if (out[cur] || cur === id) continue;
      out[cur] = true;
      (graph.prereqs[cur] || []).forEach(function (p) { stack.push(p.id); });
    }
    return out;
  }

  /** 目标 + 全部先修，稳定拓扑序（先修在前，同层按 topics.json 顺序） */
  function subgraph(graph, targets) {
    var keep = Object.create(null);
    targets.forEach(function (id) {
      keep[id] = true;
      var a = ancestors(graph, id);
      Object.keys(a).forEach(function (k) { keep[k] = true; });
    });
    var ids = Object.keys(keep);
    var indeg = Object.create(null);
    ids.forEach(function (id) { indeg[id] = 0; });
    ids.forEach(function (id) {
      (graph.prereqs[id] || []).forEach(function (p) { if (keep[p.id]) indeg[id]++; });
    });
    var ready = ids.filter(function (id) { return indeg[id] === 0; })
      .sort(function (a, b) { return graph.order[a] - graph.order[b]; });
    var out = [];
    while (ready.length) {
      var cur = ready.shift();
      out.push(cur);
      (graph.dependents[cur] || []).forEach(function (d) {
        if (!keep[d.id]) return;
        indeg[d.id]--;
        if (indeg[d.id] === 0) {
          ready.push(d.id);
          ready.sort(function (a, b) { return graph.order[a] - graph.order[b]; });
        }
      });
    }
    // 万一有环，剩下的一并附在后面（validate.py 会先把环拦下来）
    ids.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
    return out;
  }

  function isTestable(graph, id) {
    return !!(graph.questionsByTopic[id] && graph.questionsByTopic[id].length);
  }

  /* ----------------------------------------------------------- 会话 */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  function createSession(graph, targets, opts) {
    opts = opts || {};
    var ts = [];
    targets.forEach(function (t) { if (ts.indexOf(t) < 0) ts.push(t); });
    if (!ts.length) throw new Error('至少要选一个知识点');
    ts.forEach(function (id) { if (!graph.byId[id]) throw new Error('未知知识点：' + id); });

    var nodes = subgraph(graph, ts);
    var pos = Object.create(null);
    nodes.forEach(function (id, i) { pos[id] = i; });

    return {
      targets: ts,
      order: nodes,
      limit: Math.max(1, Math.floor(opts.limit == null ? DEFAULT_LIMIT : opts.limit)),
      seed: opts.seed == null ? 'xs' : String(opts.seed),
      status: {},        // id -> {s: 'mastered'|'shaky'|'weak', src: 'direct'|'inferred'}
      stack: ts.filter(function (id) { return isTestable(graph, id); })
        .sort(function (a, b) { return pos[b] - pos[a]; }),   // 离目标最近（拓扑序靠后）的先问
      answers: [],       // [{id, qid, result, text}]
      attempts: {}       // id -> [{qid, result}]
    };
  }

  function pickQuestion(graph, session, topicId, nth) {
    var pool = graph.questionsByTopic[topicId] || [];
    var used = (session.attempts[topicId] || []).map(function (a) { return a.qid; });
    var fresh = pool.filter(function (q) { return used.indexOf(q.id) < 0 && session.answers.every(function (a) { return a.qid !== q.id; }); });
    var cands = fresh.length ? fresh : pool.filter(function (q) { return used.indexOf(q.id) < 0; });
    if (!cands.length) return null;

    if (nth === 1) {
      // 第 1 题：不出 advanced（诊断第一枪要基础）
      var easy = cands.filter(function (q) { return q.difficulty !== 'advanced'; });
      var list = (easy.length ? easy : cands).slice();
      var rnd = mulberry32(hashStr(session.seed + '|' + topicId + '|1'));
      return list[Math.floor(rnd() * list.length) % list.length];
    }
    // 第 2 题：同级或更容易，优先 basic
    var first = (session.attempts[topicId] || [])[0];
    var firstRank = first && graph.questionsByTopic[topicId]
      ? DIFF_RANK[(byQid(graph, topicId, first.qid) || {}).difficulty || 'standard'] : 1;
    var sorted = cands.slice().sort(function (a, b) {
      var ra = DIFF_RANK[a.difficulty] || 0, rb = DIFF_RANK[b.difficulty] || 0;
      var pa = ra <= firstRank ? 0 : 1, pb = rb <= firstRank ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (ra !== rb) return ra - rb;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    return sorted[0];
  }

  function byQid(graph, topicId, qid) {
    var pool = graph.questionsByTopic[topicId] || [];
    for (var i = 0; i < pool.length; i++) if (pool[i].id === qid) return pool[i];
    return null;
  }

  function clone(s) {
    var attempts = {};
    Object.keys(s.attempts).forEach(function (k) { attempts[k] = s.attempts[k].slice(); });
    return {
      targets: s.targets.slice(), order: s.order.slice(), limit: s.limit, seed: s.seed,
      status: JSON.parse(JSON.stringify(s.status)), stack: s.stack.slice(),
      answers: s.answers.slice(), attempts: attempts
    };
  }

  function nextQuestion(graph, session) {
    if (session.answers.length >= session.limit) return null;
    for (var i = 0; i < session.stack.length; i++) {
      var id = session.stack[i];
      if (!session.status[id] && isTestable(graph, id)) return id;
    }
    return null;
  }

  function currentQuestion(graph, session) {
    var id = nextQuestion(graph, session);
    if (!id) return null;
    var nth = (session.attempts[id] || []).length + 1;
    var q = pickQuestion(graph, session, id, nth);
    return q ? { topicId: id, nth: nth, question: q } : null;
  }

  function applyAnswer(graph, session, topicId, result) {
    if (result !== 'correct' && result !== 'wrong') throw new Error('result 只能是 correct / wrong');
    var s = clone(session);
    if (s.status[topicId]) { delete s.status[topicId]; s.attempts[topicId] = []; }
    var prev = s.attempts[topicId] || [];
    var q = pickQuestion(graph, s, topicId, prev.length + 1);
    s.answers.push({ id: topicId, qid: q ? q.id : null, result: result });
    s.attempts[topicId] = prev.concat([{ qid: q ? q.id : null, result: result }]);
    var nth = s.attempts[topicId].length;

    if (result === 'correct') {
      if (nth === 1) {
        s.status[topicId] = { s: 'mastered', src: 'direct' };
        var anc = ancestors(graph, topicId);
        Object.keys(anc).forEach(function (a) {
          if (!s.status[a]) s.status[a] = { s: 'mastered', src: 'inferred' };
        });
      } else {
        s.status[topicId] = { s: 'shaky', src: 'direct' };
      }
    } else if (nth === 1 && pickQuestion(graph, s, topicId, 2)) {
      // 第一题没过，等第二题再下结论
    } else {
      s.status[topicId] = { s: 'weak', src: 'direct' };
      var push = graph.prereqs[topicId]
        .map(function (p) { return p.id; })
        .filter(function (p) { return isTestable(graph, p) && !s.status[p] && s.order.indexOf(p) >= 0; });
      var pushed = {};
      push.forEach(function (p) { pushed[p] = true; });
      s.stack = push.concat(s.stack.filter(function (x) { return !pushed[x]; }));
    }
    return s;
  }

  function statusOf(session, id) {
    var st = session.status[id];
    return st ? st.s : 'unknown';
  }

  /* ----------------------------------------------------------- 结论 */

  function summarize(graph, session) {
    var nodes = session.order;
    var st = function (id) { return statusOf(session, id); };
    var mastered = nodes.filter(function (id) { return st(id) === 'mastered'; });
    var shaky = nodes.filter(function (id) { return st(id) === 'shaky'; });
    var weak = nodes.filter(function (id) { return st(id) === 'weak'; });
    var untested = nodes.filter(function (id) { return st(id) === 'unknown'; });

    // 根因 = 薄弱、且它的可测先修里没有薄弱的点
    var weakSet = {};
    weak.forEach(function (id) { weakSet[id] = true; });
    var roots = weak.filter(function (id) {
      return !(graph.prereqs[id] || []).some(function (p) { return weakSet[p.id]; });
    });

    // 学习路径 = 根因与不稳点到目标之间的所有点，去掉已掌握的
    var pathSet = Object.create(null);
    var seeds = roots.concat(shaky);
    seeds.forEach(function (w) {
      var desc = Object.create(null);
      var stackQ = [w];
      while (stackQ.length) {
        var cur = stackQ.pop();
        desc[cur] = true;
        (graph.dependents[cur] || []).forEach(function (d) {
          if (session.order.indexOf(d.id) < 0) return;   // 只在本子图内
          if (!desc[d.id]) stackQ.push(d.id);
        });
      }
      var onChain = Object.create(null);
      session.targets.forEach(function (t) {
        // 目标需在 w 的后代里，才说明这条链通向目标
        if (!desc[t]) return;
        var stack2 = [t];
        while (stack2.length) {
          var cur = stack2.pop();
          if (onChain[cur]) continue;
          onChain[cur] = true;
          (graph.prereqs[cur] || []).forEach(function (p) {
            if (desc[p.id] && session.order.indexOf(p.id) >= 0) stack2.push(p.id);
          });
        }
      });
      Object.keys(onChain).forEach(function (id) { pathSet[id] = true; });
    });

    var path = Object.keys(pathSet).filter(function (id) { return st(id) !== 'mastered'; });
    // 按年级从低到高，同年级按拓扑序（先修在前）
    path.sort(function (a, b) {
      var ga = graph.byId[a].grade, gb = graph.byId[b].grade;
      if (ga !== gb) return ga - gb;
      return session.order.indexOf(a) - session.order.indexOf(b);
    });

    return {
      mastered: mastered, shaky: shaky, weak: weak, untested: untested,
      roots: roots, path: path,
      counts: {
        mastered: mastered.length, shaky: shaky.length, weak: weak.length,
        untested: untested.length, total: nodes.length
      }
    };
  }

  /** X空间 机构口径：按薄弱点数估建议课时（教研可自行调整） */
  function suggestHours(counts) {
    var n = counts.weak + counts.shaky;
    if (n === 0) return 0;
    if (n <= 2) return 2;
    if (n <= 4) return 4;
    if (n <= 6) return 6;
    return 8;
  }

  /* ----------------------------------------------------------- 判题 */

  function toHalfWidth(s) {
    return String(s)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/\u3000/g, ' ')
      .replace(/[，、；]/g, ',').replace(/。/g, '.').replace(/：/g, ':')
      .replace(/×/g, '*').replace(/÷/g, '/').replace(/[（]/g, '(').replace(/[）]/g, ')');
  }

  function normalize(s) {
    return toHalfWidth(s).replace(/\s+/g, '').replace(/^答:/, '').replace(/\.$/, '').toLowerCase();
  }

  // 语文填空题（默写、字形、释义）只有这里用：把标点全去掉再比。
  // 学生写「沉舟侧畔千帆过病树前头万木春」和「沉舟侧畔千帆过，病树前头万木春」
  // 是同一个答案，判成错会让人当场失去信任。引号书名号也一并去掉，
  // 因为默写题学生很少记得加引号。
  function stripPunct(s) {
    return normalize(s).replace(/[，。、；：？！,.;:?!""''《》〈〉「」『』（）()【】\[\]—－…·~～"']/g, '');
  }

  function parseNumber(text) {
    var s = normalize(text).replace(/^x=|^y=/, '');
    if (/^-?\d+(\.\d+)?%$/.test(s)) return parseFloat(s) / 100;
    var m = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(s);
    if (m) return parseFloat(m[1]) / parseFloat(m[2]);
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return null;
  }

  function splitAnswers(text) {
    return normalize(text).split(/[,;]/).filter(function (x) { return x !== ''; });
  }

  function judgeOne(userText, refText) {
    if (normalize(userText) === normalize(refText)) return 'correct';
    var u = parseNumber(userText), r = parseNumber(refText);
    if (u !== null && r !== null) return Math.abs(u - r) <= 1e-9 ? 'correct' : 'wrong';
    return 'manual';
  }

  function judgeQuestion(question, userText) {
    if (!question) return { verdict: 'manual', reason: '没有题目' };
    if (question.type === 'choice') {
      var ans = normalize(question.answer);
      var input = normalize(userText);
      var matchKey = null;
      (question.choices || []).forEach(function (c) {
        if (normalize(c.text) === ans || normalize(c.key) === ans) matchKey = normalize(c.key);
      });
      if (input === ans) return { verdict: 'correct', reason: '与参考答案一致' };
      if (matchKey && input === matchKey) return { verdict: 'correct', reason: '选对了选项' };
      var isAnotherOption = (question.choices || []).some(function (c) {
        return normalize(c.key) === input || normalize(c.text) === input;
      });
      if (isAnotherOption) return { verdict: 'wrong', reason: '选了别的选项' };
      return { verdict: 'manual', reason: '认不出选了哪个选项' };
    }
    if (question.type === 'fill') {
      var refs = [question.answer].concat(question.accept || []);
      var user = stripPunct(userText);
      if (!user) return { verdict: 'manual', reason: '没填答案' };
      for (var k = 0; k < refs.length; k++) {
        if (stripPunct(refs[k]) === user) return { verdict: 'correct', reason: '与参考答案一致' };
      }
      return { verdict: 'wrong', reason: '与参考答案不一致' };
    }
    if (question.type === 'numeric') {
      var refs = splitAnswers(question.answer);
      var accepts = (question.accept || []).concat([question.answer]);
      var users = splitAnswers(userText);
      if (users.length === refs.length && users.length > 1) {
        // 多答案：顺序无关
        var pool = refs.slice();
        var allOk = users.every(function (u) {
          for (var i = 0; i < pool.length; i++) {
            var r = pool[i];
            if (judgeOne(u, r) === 'correct') { pool.splice(i, 1); return true; }
          }
          return false;
        });
        return allOk ? { verdict: 'correct', reason: '多答案全部命中' } : { verdict: 'wrong', reason: '与参考答案不一致' };
      }
      for (var i = 0; i < accepts.length; i++) {
        if (judgeOne(userText, accepts[i]) === 'correct') return { verdict: 'correct', reason: '与参考答案一致' };
      }
      if (parseNumber(userText) !== null) return { verdict: 'wrong', reason: '数值不对' };
      return { verdict: 'manual', reason: '认不出这个答案，请老师对照参考答案判断' };
    }
    return { verdict: 'manual', reason: '这种题请对照参考答案自评' };
  }

  return {
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    buildGraph: buildGraph,
    ancestors: ancestors,
    subgraph: subgraph,
    isTestable: isTestable,
    createSession: createSession,
    nextQuestion: nextQuestion,
    currentQuestion: currentQuestion,
    applyAnswer: applyAnswer,
    statusOf: statusOf,
    summarize: summarize,
    suggestHours: suggestHours,
    judgeQuestion: judgeQuestion,
    normalize: normalize,
    parseNumber: parseNumber
  };
});
