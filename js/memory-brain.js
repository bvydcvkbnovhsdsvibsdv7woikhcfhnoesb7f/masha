/* MashaBrain — «мозг» Маши: профиль, темы, хроника и ассоциации для поиска.
   UMD: window.MashaBrain / module.exports.

   Зачем: поиск по словам не связывает вопрос «как мы познакомились» с её
   сообщением «Скажи спасибо дайвинчику». Этот модуль закрывает разрыв:
     1) profile    — кто она, семья, привычки, ритуалы, шутки, даты (всегда в промпте);
     2) events     — «ссоры», «встречи», «кот»… с её реальными цитатами;
     3) months     — хроника по месяцам: самые событийные её сообщения;
     4) expansions — ассоциации: «познакомились» → дайвинчик, анкета, лайкнула. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaBrain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
  'use strict';

  /* Расставание (17–18.08.2026) в её память не пускаем. */
  var BLACKOUT_FROM = 1786554000000;

  var brain = null;
  var loadedAt = 0;

  function isBlocked(ts) {
    return ts >= BLACKOUT_FROM;
  }

  function setBrain(data) {
    if (!data || typeof data !== 'object') return false;
    brain = data;
    loadedAt = Date.now();
    return true;
  }

  function getBrain() { return brain; }
  function hasBrain() { return !!(brain && brain.profile); }

  function fmtDate(ts) {
    if (!(ts > 0)) return '';
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function normDate(s) {
    // "06.09.2024" -> 2024-09-06, чтобы сравнивать с отсечкой
    var m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || ''));
    if (!m) return 0;
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }

  /* ---------- 1. Профиль: компактный блок для промпта ---------- */
  function profileBlock() {
    if (!hasBrain()) return '';
    var p = brain.profile;
    var out = [];
    var push = function (label, value) {
      if (!value) return;
      if (Array.isArray(value)) value = value.join('; ');
      out.push('- ' + label + ': ' + value);
    };
    push('Имя', (p['имена'] || []).join(' / '));
    push('Город', p['город']);
    push('Возраст', p['возраст']);
    push('Семья', p['семья']);
    push('Учёба', p['учёба']);
    push('Тренировки', p['тренировки']);
    push('Здоровье', p['здоровье']);
    push('Любит', p['любит']);
    push('Боится', p['боится']);
    push('Мечтает', p['мечтает']);
    push('Внутренние шутки', p['внутренние_шутки']);
    push('Ритуалы', p['ритуалы']);
    push('Характер', p['характер']);
    var kd = p['ключевые_даты'];
    if (kd) push('Ключевые даты', Object.keys(kd).map(function (k) { return k.replace(/_/g, ' ') + ' — ' + kd[k]; }));
    return out.join('\n');
  }

  /* ---------- 2. Ассоциации: расширяем запрос ---------- */
  function expandTerms(terms) {
    if (!hasBrain() || !brain.expansions) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < (terms || []).length; i++) {
      var t = String(terms[i] || '').toLowerCase();
      var keys = Object.keys(brain.expansions);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (t.indexOf(key) === 0 || key.indexOf(t) === 0 || t === key) {
          var list = brain.expansions[key] || [];
          for (var j = 0; j < list.length; j++) {
            var w = String(list[j] || '').toLowerCase();
            if (w && !seen[w]) { seen[w] = true; out.push(w); }
          }
        }
      }
    }
    return out;
  }

  /* ---------- 3. Темы и хроника по запросу ---------- */
  /* Служебные слова: по ним тему не выбираем, иначе «как дела в школе» уходит
     в тему «как они познакомились». */
  var TOPIC_STOP = {
    'как': 1, 'что': 1, 'где': 1, 'кто': 1, 'чем': 1, 'для': 1, 'это': 1, 'мне': 1, 'тебе': 1,
    'себя': 1, 'было': 1, 'есть': 1, 'дела': 1, 'очень': 1, 'надо': 1, 'хочу': 1, 'может': 1,
    'давай': 1, 'когда': 1, 'тогда': 1, 'зачем': 1, 'почему': 1, 'тоже': 1, 'если': 1, 'чтобы': 1,
    'него': 1, 'нее': 1, 'них': 1, 'вас': 1, 'нас': 1, 'них': 1, 'расскажи': 1, 'помнишь': 1,
    'помню': 1, 'знаешь': 1, 'скажи': 1, 'были': 1, 'была': 1, 'там': 1, 'тут': 1
  };

  function scoreTopic(title, text) {
    var words = String(text || '').toLowerCase().split(/[^а-яёa-z0-9]+/)
      .filter(function (w) { return w.length >= 4 && !TOPIC_STOP[w]; });
    if (!words.length) return 0;
    var t = String(title).toLowerCase();
    var parts = t.split(/[\s,«»]+/);
    var hits = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var short = w.slice(0, Math.max(4, w.length - 2));
      if (t.indexOf(short) !== -1) hits += short.length;    // чем длиннее совпадение, тем весомее
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        if (part.length >= 3 && (part.indexOf(w.slice(0, 3)) === 0 || w.indexOf(part.slice(0, 3)) === 0)) hits++;
      }
    }
    return hits;
  }

  function topicBlock(query, maxTopics) {
    if (!hasBrain() || !brain.events) return '';
    var scored = [];
    var keys = Object.keys(brain.events);
    for (var i = 0; i < keys.length; i++) {
      var s = scoreTopic(keys[i], query);
      if (s > 0) scored.push({ title: keys[i], score: s, data: brain.events[keys[i]] });
    }
    if (!scored.length) return '';
    scored.sort(function (a, b) { return b.score - a.score; });
    var limit = maxTopics || 2;
    var out = [];
    for (var j = 0; j < scored.length && j < limit; j++) {
      var t = scored[j].data;
      var quotes = (t.quotes || []).filter(function (q) { return !isBlocked(normDate(q.date)); }).slice(0, 6);
      if (!quotes.length) continue;
      out.push('▸ ' + scored[j].title + ' (' + t.count + ' упоминаний, с ' + t.first + ' по ' + t.last + ')');
      for (var q = 0; q < quotes.length; q++) out.push('   [' + quotes[q].date + '] ' + quotes[q].text);
    }
    return out.join('\n');
  }

  function monthFor(query) {
    if (!hasBrain() || !brain.months) return null;
    var m = /(\d{4})-(\d{2})/.exec(String(query || ''));
    if (m) {
      var ym = m[1] + '-' + m[2];
      for (var i = 0; i < brain.months.length; i++) if (brain.months[i].ym === ym) return brain.months[i];
      return null;
    }
    var rus = /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i.exec(String(query || ''));
    if (!rus) return null;
    var idx = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр']
      .findIndex(function (p) { return rus[0].toLowerCase().indexOf(p) === 0; });
    if (idx < 0) return null;
    var year = /(\d{4})/.exec(query);
    var y = year ? year[1] : String(new Date().getFullYear());
    var want = y + '-' + (idx + 1 < 10 ? '0' : '') + (idx + 1);
    for (var j = 0; j < brain.months.length; j++) if (brain.months[j].ym === want) return brain.months[j];
    return null;
  }

  function monthBlock(query) {
    var m = monthFor(query);
    if (!m) return '';
    var quotes = (m.quotes || []).filter(function (q) { return true; }).slice(0, 5);
    if (!quotes.length) return '';
    return '▸ ' + m.ym + ' (' + m.count + ' её сообщений, темы: ' + (m.words || []).join(', ') + ')\n' +
      quotes.map(function (q) { return '   • ' + q; }).join('\n');
  }

  /* ---------- 4. Сборка блока памяти ---------- */
  function assemble(query, episodes, opts) {
    opts = opts || {};
    var maxChars = opts.maxChars || 9000;
    var withProfile = opts.withProfile !== false;
    var parts = [];
    if (withProfile) {
      var pb = profileBlock();
      if (pb) parts.push('═══ ТВОЙ ПРОФИЛЬ (это ты) ═══\n' + pb);
    }
    var tb = topicBlock(query, opts.maxTopics || 2);
    if (tb) parts.push('═══ ЧТО БЫЛО ПО ЭТОЙ ТЕМЕ (реальные твои сообщения) ═══\n' + tb);
    var mb = monthBlock(query);
    if (mb) parts.push('═══ ТОТ МЕСЯЦ (хроника) ═══\n' + mb);
    if (episodes && episodes.length) {
      var block = (G.MashaSearch && G.MashaSearch.buildContextBlock)
        ? G.MashaSearch.buildContextBlock(episodes, { maxChars: Math.max(1500, maxChars - 3000) })
        : '';
      if (block) parts.push(block);
    }
    var text = parts.join('\n\n');
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return text;
  }

  return {
    BLACKOUT_FROM: BLACKOUT_FROM,
    isBlocked: isBlocked,
    setBrain: setBrain,
    getBrain: getBrain,
    hasBrain: hasBrain,
    profileBlock: profileBlock,
    expandTerms: expandTerms,
    topicBlock: topicBlock,
    monthBlock: monthBlock,
    assemble: assemble
  };
});
