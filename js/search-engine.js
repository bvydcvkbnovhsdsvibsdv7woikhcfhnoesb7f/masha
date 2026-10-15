/* MashaSearch — разбор текста: ключевые слова, стемминг-лайт, блок «воспоминаний».
   UMD: в браузере window.MashaSearch, в Node — module.exports. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STOPWORDS = new Set((
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по ' +
    'только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ' +
    'ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где ' +
    'есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда ' +
    'кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были ' +
    'куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас ' +
    'про всего них какая много разве три эту моя впрочем свою этой перед иногда лучше чуть том нельзя ' +
    'такой им более всегда конечно всю между это оно ах ох ух эх кстати вообще просто очень короче ' +
    'типа типо вроде кажись значит ага угу ладно ок окей ясно спс спасибо пожалуйста привет пока ' +
    'щас знаю знаешь хочешь будешь давай надо можно нету ничего такое кажется наверное почему зачем ' +
    'когда сегодня завтра вчера постоянно сильно прям блин капец пипец ужас кошмар хватит совсем ' +
    'здесь там тогда куда откуда почему-то как-то что-то кто-то это этот эта эти того тому ' +
    'the a an and or of to in is it you i we they he she for on with that this not be are was were ' +
    'at as by from have has had do does did but if then so my me your'
  ).split(/\s+/));

  /* Частые русские окончания — срезаем по одному, основа не короче 4 букв. */
  var ENDINGS = [
    'иями', 'ями', 'ами', 'ией', 'иях', 'ов', 'ев', 'ий', 'ый', 'ая', 'ое', 'ые', 'ой', 'ей',
    'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ую', 'юю', 'ия', 'ие', 'ии', 'ть', 'ся', 'сь',
    'ла', 'ло', 'ли', 'ал', 'ял', 'ил', 'ел', 'а', 'я', 'ы', 'и', 'е', 'у', 'ю', 'о', 'ь'
  ];

  /* Все варианты основы слова: сколько проходов стемминга ни применялось бы.
     Нужно потому, что индекс может быть построен другой версией алгоритма —
     «поссорились» там лежит как «поссорили», а новый запрос даёт «поссор». */
  function termVariants(word) {
    var w = String(word || '').toLowerCase().replace(/ё/g, 'е');
    if (w.length < 4) return [];
    var out = [];
    var seen = {};
    var cur = w;
    for (var pass = 0; pass < 3; pass++) {
      var changed = false;
      for (var i = 0; i < ENDINGS.length; i++) {
        var end = ENDINGS[i];
        if (cur.length - end.length >= 4 && cur.slice(-end.length) === end) {
          cur = cur.slice(0, cur.length - end.length);
          changed = true;
          break;
        }
      }
      if (changed && !seen[cur] && cur !== w) { seen[cur] = true; out.push(cur); }
      if (!changed) break;
    }
    return out;
  }

  function tokenize(text) {
    var s = String(text === null || text === undefined ? '' : text)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9\s\-_]+/g, ' ');
    var parts = s.split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i].replace(/^-+|-+$/g, '');
      if (w.length >= 2) out.push(w);
    }
    return out;
  }

  function normalizeTerm(word) {
    var w = String(word || '').toLowerCase().replace(/ё/g, 'е');
    if (w.length < 4) return w;
    // До трёх проходов: «поссорились» -> «поссорили» -> «поссори» -> «поссор»
    for (var pass = 0; pass < 3; pass++) {
      var changed = false;
      for (var i = 0; i < ENDINGS.length; i++) {
        var end = ENDINGS[i];
        if (w.length - end.length >= 4 && w.slice(-end.length) === end) {
          w = w.slice(0, w.length - end.length);
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    return w;
  }

  /* Значимые термины сообщения: без стоп-слов, без цифрового мусора, с дедупликацией. */
  function extractKeywords(text, limit) {
    var max = limit > 0 ? limit : 12;
    var words = tokenize(text);
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < words.length && out.length < max; i++) {
      var w = words[i];
      if (w.length < 3) continue;
      if (!/[a-zа-я]/.test(w)) continue;
      if (STOPWORDS.has(w)) continue;
      var stem = normalizeTerm(w);
      if (stem.length < 3 || STOPWORDS.has(stem) || seen[stem]) continue;
      seen[stem] = true;
      out.push(stem);
    }
    return out;
  }

  function keywordsFromMany(texts, limit) {
    var counts = Object.create(null);
    for (var i = 0; i < (texts || []).length; i++) {
      var ks = extractKeywords(texts[i], 12);
      for (var j = 0; j < ks.length; j++) counts[ks[j]] = (counts[ks[j]] || 0) + 1;
    }
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, limit || 12);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatDate(ts) {
    if (!(ts > 0)) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  function oneLine(text, max) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  /* Эпизоды -> текстовый блок для промпта. Строго не длиннее maxChars. */
  function buildContextBlock(episodes, opts) {
    var o = opts || {};
    var maxChars = o.maxChars > 0 ? o.maxChars : 3000;
    var header = o.header === undefined ? 'ФРАГМЕНТЫ ИЗ АРХИВА ПЕРЕПИСКИ (реальные старые сообщения)' : o.header;
    if (!episodes || !episodes.length || maxChars <= 0) return '';

    var lines = [];
    var used = 0;
    function push(line) {
      if (used + line.length + 1 > maxChars) return false;
      lines.push(line);
      used += line.length + 1;
      return true;
    }

    if (header && !push('[' + header + ']')) return ('[' + header + ']').slice(0, maxChars);

    for (var i = 0; i < episodes.length; i++) {
      var ep = episodes[i];
      var head = '--- ' + (formatDate(ep.ts) || 'без даты') + ' ---';
      var block = [];
      var items = ep.items || [];
      for (var j = 0; j < items.length; j++) {
        var m = items[j];
        if (!m || !m.content) continue;
        block.push((m.role === 'user' ? 'он: ' : 'она: ') + oneLine(m.content, 220));
      }
      if (!block.length) continue;
      if (used + head.length + block.join('\n').length + 2 > maxChars) break;
      push(head);
      for (var k = 0; k < block.length; k++) push(block[k]);
    }
    return lines.join('\n');
  }

  function dedupeEpisodes(episodes) {
    var out = [];
    var seen = [];
    for (var i = 0; i < (episodes || []).length; i++) {
      var ep = episodes[i];
      var seqs = (ep.items || []).map(function (m) { return m.seq; });
      var overlap = false;
      for (var s = 0; s < seen.length && !overlap; s++) {
        for (var q = 0; q < seqs.length; q++) {
          if (seen[s].indexOf(seqs[q]) !== -1) { overlap = true; break; }
        }
      }
      if (overlap) continue;
      seen.push(seqs);
      out.push(ep);
    }
    return out;
  }

  function rankMessages(messages, terms) {
    var out = [];
    for (var i = 0; i < (messages || []).length; i++) {
      var m = messages[i];
      var text = String((m && m.content) || '').toLowerCase();
      var score = 0;
      for (var t = 0; t < (terms || []).length; t++) {
        if (text.indexOf(terms[t]) !== -1) score++;
      }
      if (score > 0) out.push({ msg: m, score: score });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  return {
    STOPWORDS: STOPWORDS,
    ENDINGS: ENDINGS,
    tokenize: tokenize,
    normalizeTerm: normalizeTerm,
    termVariants: termVariants,
    extractKeywords: extractKeywords,
    keywordsFromMany: keywordsFromMany,
    formatDate: formatDate,
    estimateTokens: estimateTokens,
    buildContextBlock: buildContextBlock,
    dedupeEpisodes: dedupeEpisodes,
    rankMessages: rankMessages
  };
});
