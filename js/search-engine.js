/*! MashaSearch — чистые функции: токенизация, стемминг-лайт, ключевые слова,
 *  ранжирование и сборка контекста для RAG.
 *  UMD: в браузере — globalThis.MashaSearch, в Node — require('../js/search-engine.js').
 *  Без DOM, без БД, без внешних зависимостей.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_HEADER = 'ФРАГМЕНТЫ ИЗ АРХИВА ПЕРЕПИСКИ (реальные старые сообщения)';

  var STOPWORDS = new Set([
    /* ---------- русские ---------- */
    'а', 'без', 'более', 'больше', 'будет', 'будто', 'бы', 'был', 'была', 'были', 'было',
    'быть', 'в', 'вам', 'вас', 'вдруг', 'ведь', 'во', 'вот', 'впрочем', 'все', 'всего',
    'всех', 'всю', 'вы', 'где', 'да', 'даже', 'два', 'для', 'до', 'другой', 'его', 'ее',
    'ей', 'ему', 'если', 'есть', 'еще', 'ж', 'же', 'за', 'зачем', 'здесь', 'и', 'из',
    'или', 'им', 'иногда', 'их', 'к', 'как', 'какая', 'какой', 'когда', 'конечно', 'котор', 'кто', 'куда',
    'ли', 'лучше', 'между', 'меня', 'мне', 'мной', 'много', 'может', 'можно', 'мой', 'моя', 'мы',
    'на', 'над', 'надо', 'наконец', 'нас', 'не', 'него', 'нее', 'ней', 'нельзя', 'нет',
    'ни', 'никогда', 'ним', 'них', 'ничего', 'но', 'ну', 'о', 'об', 'один', 'он', 'она',
    'они', 'опять', 'от', 'перед', 'по', 'под', 'после', 'потом', 'потому', 'почти',
    'при', 'про', 'просто', 'раз', 'разве', 'с', 'сам', 'свою', 'себе', 'себя', 'сейчас', 'со',
    'совсем', 'так', 'такой', 'также', 'там', 'тебе', 'тебя', 'тем', 'теперь', 'то', 'тобой', 'тогда', 'того',
    'тоже', 'только', 'том', 'тот', 'тут', 'ты', 'у', 'уж', 'уже', 'хорошо', 'хоть',
    'чего', 'чем', 'через', 'что', 'чтоб', 'чтобы', 'чуть', 'эта', 'эти', 'это', 'этого',
    'этой', 'этом', 'этот', 'эту', 'я',
    /* ---------- английские ---------- */
    'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
    'be', 'because', 'been', 'before', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
    'doing', 'don', 'down', 'for', 'from', 'had', 'has', 'have', 'having', 'he', 'her',
    'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
    'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
    'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'said', 'same', 'she',
    'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then',
    'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
    'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
    'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours'
  ]);

  /* Частые русские окончания: срезаем самое длинное подходящее,
   * но никогда не укорачиваем основу меньше 4 символов. */
  var RU_ENDINGS = [
    /* 4 */
    'иями',
    /* 3 */
    'ями', 'ами', 'ией', 'иях', 'иям', 'ием', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему',
    'ить', 'ать', 'ять', 'еть', 'ешь', 'ишь',
    /* 2 */
    'ей', 'ой', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ов', 'ев', 'ам', 'ям',
    'ах', 'ях', 'ом', 'ем', 'ую', 'юю', 'ия', 'ть', 'ся', 'сь',
    /* 1 */
    'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'й', 'ь'
  ];

  var TOKEN_SPLIT = /[^a-zа-я]+/;
  var HAS_LETTER = /[a-zа-я]/;
  var ONLY_DIGITS = /^[0-9]+$/;

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* ---------- 1. токенизация ---------- */

  function tokenize(text) {
    if (text === null || text === undefined) return [];
    var s = String(text).toLowerCase().replace(/ё/g, 'е');
    var parts = s.split(TOKEN_SPLIT);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i];
      if (!w || w.length < 2) continue;
      if (ONLY_DIGITS.test(w)) continue;      // мусор из цифр
      if (!HAS_LETTER.test(w)) continue;      // пунктуация/символы
      out.push(w);
    }
    return out;
  }

  /* ---------- 2. стемминг-лайт ---------- */

  function normalizeTerm(word) {
    var toks = tokenize(word);
    var t = toks.length ? toks[0] : '';
    if (!t) return '';
    for (var i = 0; i < RU_ENDINGS.length; i++) {
      var end = RU_ENDINGS[i];
      if (t.length - end.length >= 4 && t.slice(t.length - end.length) === end) {
        return t.slice(0, t.length - end.length);
      }
    }
    return t;
  }

  /* ---------- 3. ключевые слова ---------- */

  function pickTop(count, first, limit) {
    var terms = Array.from(count.keys());
    terms.sort(function (a, b) {
      var d = count.get(b) - count.get(a);          // чаще — выше
      if (d) return d;
      var fa = first.get(a), fb = first.get(b);     // раньше встретился — выше
      if (fa !== fb) return fa - fb;
      return a < b ? -1 : (a > b ? 1 : 0);          // детерминированный тай-брейк
    });
    var n = num(limit);
    if (n < 0) n = 0;
    return terms.slice(0, n);
  }

  function extractKeywords(text, limit) {
    if (limit === undefined || limit === null) limit = 12;
    var toks = tokenize(text);
    if (!toks.length) return [];
    var count = new Map();
    var first = new Map();
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];
      if (STOPWORDS.has(tok)) continue;
      var term = normalizeTerm(tok);
      if (!term || term.length < 3) continue;
      if (STOPWORDS.has(term)) continue;
      if (!count.has(term)) {
        count.set(term, 0);
        first.set(term, i);
      }
      count.set(term, count.get(term) + 1);
    }
    if (!count.size) return [];
    return pickTop(count, first, limit);
  }

  function keywordsFromMany(texts, limit) {
    if (limit === undefined || limit === null) limit = 12;
    var list = Array.isArray(texts) ? texts : (texts === null || texts === undefined ? [] : [texts]);
    var count = new Map();
    var first = new Map();
    var order = 0;
    for (var i = 0; i < list.length; i++) {
      var kws = extractKeywords(list[i], 1000000);
      var seen = new Set();
      for (var j = 0; j < kws.length; j++) {
        var k = kws[j];
        if (seen.has(k)) continue;             // считаем по числу текстов, а не вхождений
        seen.add(k);
        if (!count.has(k)) {
          count.set(k, 0);
          first.set(k, order++);
        }
        count.set(k, count.get(k) + 1);
      }
    }
    if (!count.size) return [];
    return pickTop(count, first, limit);
  }

  /* ---------- 4. ранжирование ---------- */

  function rankMessages(messages, terms) {
    var out = [];
    if (!Array.isArray(messages) || !messages.length) return out;
    var want = new Set();
    var list = Array.isArray(terms) ? terms : (terms === null || terms === undefined ? [] : [terms]);
    for (var t = 0; t < list.length; t++) {
      if (list[t] === null || list[t] === undefined) continue;
      var nt = normalizeTerm(list[t]);
      if (nt) want.add(nt);
    }
    if (!want.size) return out;

    var minTs = Infinity, maxTs = -Infinity;
    for (var m = 0; m < messages.length; m++) {
      var ts0 = num(messages[m] && messages[m].ts);
      if (ts0 > 0) {
        if (ts0 < minTs) minTs = ts0;
        if (ts0 > maxTs) maxTs = ts0;
      }
    }

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      var toks = tokenize(msg.content);
      var matched = new Set();
      for (var k = 0; k < toks.length; k++) {
        if (STOPWORDS.has(toks[k])) continue;
        var term = normalizeTerm(toks[k]);
        if (term && want.has(term)) matched.add(term);
      }
      if (!matched.size) continue;
      var ts = num(msg.ts);
      var fresh = (maxTs > minTs && ts > 0)
        ? Math.round(99 * (ts - minTs) / (maxTs - minTs))
        : 99;
      out.push({ msg: msg, score: matched.size * 100 + fresh, _i: i, _ts: ts });
    }
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b._ts !== a._ts) return b._ts - a._ts;
      return a._i - b._i;
    });
    return out.map(function (r) { return { msg: r.msg, score: r.score }; });
  }

  /* ---------- 5. сборка контекста ---------- */

  function collapse(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function buildContextBlock(episodes, opts) {
    var o = opts || {};
    var maxChars = (o.maxChars === undefined || o.maxChars === null)
      ? 3500
      : Math.max(0, Math.floor(num(o.maxChars)));
    var header = (o.header === undefined || o.header === null) ? DEFAULT_HEADER : String(o.header);
    if (!Array.isArray(episodes) || episodes.length === 0 || maxChars <= 0) return '';

    var out = '';
    var contentLines = 0;

    function tryPush(line) {
      var add = out ? 1 : 0;
      if (out.length + add + line.length > maxChars) return false;
      out += (add ? '\n' : '') + line;
      return true;
    }

    if (header) {
      var head = '[' + header + ']';
      if (!tryPush(head)) return maxChars >= 2 ? head.slice(0, maxChars) : '';
    }

    for (var i = 0; i < episodes.length; i++) {
      var ep = episodes[i] || {};
      var date = formatDate(num(ep.ts));
      if (!tryPush(date ? ('--- ' + date + ' ---') : '---')) break;
      var items = Array.isArray(ep.items) ? ep.items : [];
      var stop = false;
      for (var j = 0; j < items.length; j++) {
        var it = items[j] || {};
        var text = collapse(it.content);
        if (!text) continue;
        var line = (it.role === 'assistant' ? 'она: ' : 'он: ') + text;
        if (tryPush(line)) { contentLines++; continue; }
        if (contentLines === 0) {
          var room = maxChars - out.length - 1;
          if (room > 1) {
            out += '\n' + line.slice(0, room - 1) + '…';
            contentLines++;
          }
        }
        stop = true;
        break;
      }
      if (stop) break;
    }
    return out;
  }

  function formatDate(ts) {
    var n = num(ts);
    if (!(n > 0)) return '';
    var d = new Date(n);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function estimateTokens(text) {
    if (text === null || text === undefined) return 0;
    var s = String(text);
    if (!s.length) return 0;
    return Math.ceil(s.length / 4);
  }

  function dedupeEpisodes(episodes) {
    if (!Array.isArray(episodes)) return [];
    var seen = new Set();
    var out = [];
    for (var i = 0; i < episodes.length; i++) {
      var ep = episodes[i];
      if (!ep || typeof ep !== 'object') continue;
      var items = Array.isArray(ep.items) ? ep.items : [];
      var head = items.length ? items[0] : null;
      var key = 's' + num(ep.seq) + '|t' + num(ep.ts) + '|n' + items.length + '|' +
        (head ? (num(head.id) + '#' + num(head.seq) + '#' + String(head.content || '').length) : '-');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ep);
    }
    return out;
  }

  return {
    STOPWORDS: STOPWORDS,
    tokenize: tokenize,
    normalizeTerm: normalizeTerm,
    extractKeywords: extractKeywords,
    keywordsFromMany: keywordsFromMany,
    rankMessages: rankMessages,
    buildContextBlock: buildContextBlock,
    formatDate: formatDate,
    estimateTokens: estimateTokens,
    dedupeEpisodes: dedupeEpisodes,
    DEFAULT_HEADER: DEFAULT_HEADER,
    RU_ENDINGS: RU_ENDINGS
  };
});
