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
  var kb = null;
  var voice = null;
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

  function setKb(data) {
    if (!data || typeof data !== 'object') return false;
    kb = data;
    return true;
  }
  function hasKb() { return !!(kb && (kb.people || kb.topics)); }

  function setVoice(data) {
    if (!data || typeof data !== 'object') return false;
    voice = data;
    return true;
  }
  function hasVoice() { return !!(voice && voice.pairs && voice.archetypes); }

  /* ---------- Голос: как она говорит в реальности ---------- */
  function stem4(w) { return String(w || '').toLowerCase().slice(0, 4); }

  function bankBlock(query, opts) {
    opts = opts || {};
    if (!hasVoice()) return '';
    var qw = words4(query);
    if (!qw.length) return '';
    var qs = qw.map(stem4);
    var out = [];

    // 1) «вопрос → её реальный ответ» — самые похожие пары
    var pairs = voice.pairs || [];
    var scored = [];
    for (var i = 0; i < pairs.length; i++) {
      var pr = pairs[i];
      var pw = words4(pr.q).map(stem4);
      var hit = 0;
      for (var a = 0; a < pw.length; a++) if (qs.indexOf(pw[a]) !== -1) hit++;
      if (hit > 0) scored.push({ hit: hit / Math.sqrt(pw.length + 1), p: pr });
    }
    scored.sort(function (x, y) { return y.hit - x.hit; });
    if (scored.length) {
      var lines = ['═══ КАК ТЫ ОТВЕЧАЛА НА ТАКОЕ (реальные пары из переписки) ═══'];
      for (var k = 0; k < scored.length && k < 6; k++) {
        lines.push('он: ' + scored[k].p.q + '\nты: ' + scored[k].p.a);
      }
      out.push(lines.join('\n'));
    }

    // 2) архетипы: подходящие по смыслу вопроса
    var arche = voice.archetypes || {};
    var archHints = {
      'обида/злость': /(беси|обид|дурак|отстан|достал|игнор|почему не|и что)/i,
      'нежность': /(любл|скуча|зая|коть|обним|целу|соскучил)/i,
      'приветствие': /(привет|хай|доброе утро|здравств)/i,
      'прощание/сон': /(спать|спокойной|пока|до завтра|ложись)/i,
      'отказ': /(не хочу|не буду|не могу|нет)/i,
      'согласие': /(да|ага|хорошо|ладно|ок)/i,
      'еда': /(еда|кушать|поесть|голод|вкусн|кофе|чипс|шаурм)/i,
      'кот': /(кот|котик|котён|кошк)/i,
      'школа': /(школ|урок|класс|учител|экзамен)/i,
      'семья': /(мама|папа|брат|малой|бабушк|ван)/i,
      'игры': /(игра|роблокс|майнкрафт|бравл|гренни)/i,
      'музыка/фильм': /(песн|музык|фильм|сериал|тикток)/i,
      'подруги': /(подруг|настя|полина|ксюш|друз)/i,
      'сно/сон': /(сон|выспал|устал|лежу)/i,
      'быт': /(магазин|уборк|готовл|погуля|поехал)/i,
      'шутка/смех': /(смешн|хаха|прикол|шутк|кринж)/i
    };
    var picked = [];
    for (var name in archHints) {
      if (archHints[name].test(query) && arche[name] && arche[name].examples) picked.push(name);
      if (picked.length >= 2) break;
    }
    if (picked.length) {
      for (var p = 0; p < picked.length; p++) {
        var block = arche[picked[p]];
        var ex = (block.examples || []).slice(0, 8);
        if (!ex.length) continue;
        var ls = ['═══ ТВОИ ЖИВЫЕ ФРАЗЫ — ' + picked[p] + ' (' + block.count + ' твоих сообщений) ═══'];
        for (var e = 0; e < ex.length; e++) ls.push('«' + ex[e].t + '»');
        out.push(ls.join('\n'));
      }
    }

    // 3) как она рассказывает — если просят рассказать
    if (/(расскаж|как прошло|что нового|как дела|что дела|помнишь)/i.test(query) && voice.storytelling) {
      var st = (voice.storytelling.examples || []).slice(0, 3);
      if (st.length) {
        var sl = ['═══ КАК ТЫ РАССКАЗЫВАЕШЬ (примеры твоих рассказов) ═══'];
        for (var s = 0; s < sl.length - 0 && s < st.length; s++) sl.push('«' + st[s].t + '»');
        out.push(sl.join('\n'));
      }
    }

    var text = out.join('\n\n');
    var limit = opts.maxChars || 3200;
    return text.length > limit ? text.slice(0, limit) : text;
  }

  /* ---------- База знаний: люди, темы, месяцы, шутки ---------- */
  function words4(text) {
    return String(text || '').toLowerCase().split(/[^а-яёa-z0-9]+/).filter(function (w) { return w.length >= 4; });
  }

  function kbBlock(query, opts) {
    opts = opts || {};
    if (!hasKb()) return '';
    var q = String(query || '').toLowerCase();
    // расширяем вопрос ассоциациями: «познакомились» → дайвинчик, анкета, лайкнула
    var expanded = q;
    if (typeof expandTerms === 'function') {
      var extra = expandTerms(words4(q));
      if (extra.length) expanded = q + ' ' + extra.join(' ');
    }
    var qw = words4(expanded);
    var out = [];

    // 1) люди: ищем имя из вопроса
    var people = kb.people || [];
    var hitPeople = [];
    for (var i = 0; i < people.length; i++) {
      var nm = String(people[i].name || '').toLowerCase();
      if (nm.length < 3) continue;
      var stem = nm.slice(0, Math.max(3, nm.length - 1));
      if (q.indexOf(stem) !== -1) hitPeople.push(people[i]);
    }
    if (hitPeople.length) {
      var lines = ['═══ О ЛЮДЯХ (из переписки) ═══'];
      for (var p = 0; p < hitPeople.length && p < 3; p++) {
        var per = hitPeople[p];
        lines.push('▸ ' + per.name + ' — упоминается ' + per.count + ' раз' +
          (per.roles && per.roles.length ? ', роль: ' + per.roles.join(', ') : ''));
        var qs = (per.quotes || []).slice(0, 3);
        for (var k = 0; k < qs.length; k++) lines.push('   [' + qs[k].date + '] ' + qs[k].text);
      }
      out.push(lines.join('\n'));
    }

    // 2) темы: по совпадению слов вопроса с названием темы
    var topics = kb.topics || {};
    var tkeys = Object.keys(topics);
    var scored = [];
    for (var t = 0; t < tkeys.length; t++) {
      var title = tkeys[t].toLowerCase();
      var score = 0;
      for (var w = 0; w < qw.length; w++) {
        var short = qw[w].slice(0, 4);                 // «ссорились» → «ссор» найдёт тему «ссоры и обиды»
        if (short.length >= 4 && title.indexOf(short) !== -1) score += 4;
      }
      if (score > 0) scored.push({ title: tkeys[t], score: score, data: topics[tkeys[t]] });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    if (scored.length) {
      var tl = ['═══ ЧТО БЫЛО ПО ТЕМЕ (её слова) ═══'];
      for (var s = 0; s < scored.length && s < 2; s++) {
        var d = scored[s].data;
        tl.push('▸ ' + scored[s].title + ' (' + d.count + ' её сообщений)');
        var dq = (d.quotes || []).filter(function (x) { return !isBlocked(normDate(x.date)); }).slice(0, 5);
        for (var j = 0; j < dq.length; j++) tl.push('   [' + dq[j].date + '] ' + dq[j].text);
      }
      out.push(tl.join('\n'));
    }

    // 3) месяц, если он назван
    var mm = /(\d{4})-(\d{2})/.exec(q);
    var monthName = /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i.exec(q);
    var yearGiven = /(20\d{2})/.exec(q);
    var monthData = null;
    if (mm) {
      monthData = (kb.months || []).filter(function (x) { return x.ym === mm[1] + '-' + mm[2]; })[0];
    } else if (monthName) {
      var idx = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр']
        .findIndex(function (p) { return monthName[0].toLowerCase().indexOf(p) === 0; });
      if (idx >= 0) {
        var num = (idx + 1 < 10 ? '0' : '') + (idx + 1);
        if (yearGiven) {
          monthData = (kb.months || []).filter(function (x) { return x.ym === yearGiven[1] + '-' + num; })[0] || null;
        } else {
          var cand = (kb.months || []).filter(function (x) { return x.ym.slice(-3) === '-' + num; });
          monthData = cand[cand.length - 1] || null;
        }
      }
    }
    if (monthData) {
      var ml = ['═══ ТОТ МЕСЯЦ (хроника) ═══', '▸ ' + monthData.ym + ': ' + monthData.count + ' сообщений, темы: ' + (monthData.topics || []).join(', ')];
      var mq = (monthData.quotes || []).filter(function (x) { return !isBlocked(normDate(x.date)); }).slice(0, 4);
      for (var n = 0; n < mq.length; n++) ml.push('   [' + mq[n].date + '] ' + mq[n].text);
      out.push(ml.join('\n'));
    }

    // 4) шутки по ключевому слову
    var jokes = kb.jokes || {};
    var jkeys = Object.keys(jokes);
    for (var jj = 0; jj < jkeys.length; jj++) {
      var jt = jkeys[jj].toLowerCase();
      var jhit = qw.some(function (w) { return jt.indexOf(w.slice(0, Math.max(4, w.length - 2))) !== -1; });
      if (jhit && (jokes[jkeys[jj]] || []).length) {
        var jl = ['═══ ВАША ШУТКА: ' + jkeys[jj] + ' ═══'];
        jokes[jkeys[jj]].slice(0, 3).forEach(function (x) { jl.push('   [' + x.date + '] ' + x.text); });
        out.push(jl.join('\n'));
        break;
      }
    }

    var text = out.join('\n\n');
    var limit = opts.maxChars || 4000;
    return text.length > limit ? text.slice(0, limit) : text;
  }

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
    push('Настоящее имя', p['настоящее_имя']);
    push('Про имя (важная деталь)', p['легенда']);
    push('Отчество', p['отчество']);
    push('Как он тебя зовёт', p['как_он_её_зовёт']);
    push('Как ты его зовёшь', p['как_она_его_зовёт']);
    push('Твои словечки', p['её_словечки']);
    push('Твои игры и спорт', p['её_игры_и_спорт']);
    push('Твоя музыка', p['её_музыка']);
    push('Твои мемы и интернет', p['её_мемы']);
    push('Твои увлечения', p['её_увлечения']);
    push('Твои люди', p['её_люди']);
    push('Что он для тебя', p['что_он_для_неё']);
    push('ВАЖНО про вас', p['важно_про_вас']);
    push('Как пишет он', p['его_манера']);
    push('Важные даты', p['важные_даты']);
    push('Твой ритм', p['твой_ритм']);
    push('Город', p['город']);
    push('Возраст', p['возраст']);
    push('Рост/вес', p['рост_вес']);
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
    var kbText = kbBlock(query, { maxChars: Math.max(1200, Math.round(maxChars * 0.4)) });
    if (kbText) parts.push(kbText);
    var voiceText = bankBlock(query, { maxChars: Math.max(1200, Math.round(maxChars * 0.35)) });
    if (voiceText) parts.push(voiceText);
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
    setKb: setKb,
    hasKb: hasKb,
    setVoice: setVoice,
    hasVoice: hasVoice,
    bankBlock: bankBlock,
    kbBlock: kbBlock,
    profileBlock: profileBlock,
    expandTerms: expandTerms,
    topicBlock: topicBlock,
    monthBlock: monthBlock,
    assemble: assemble
  };
});
