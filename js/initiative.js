/*
 * MashaInitiative — «Маша пишет первой».
 *
 * Раньше в index.html была наивная проверка (не писал 30 минут и я не писала 10),
 * которая на практике почти никогда не срабатывала: она зависела от неудачных
 * запросов к API и не учитывала ночь, события, кап на день и «он не отвечает».
 *
 * Здесь: расписание по Красноярску, уважение к режиму сна, поводы (утро/вечер/праздник),
 * ограничение частоты, откат если она пишет, а он молчит, уведомления.
 *
 * UMD: window.MashaInitiative / module.exports.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaInitiative = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LOG_KEY = 'masha_initiative_log';
  var TZ = 'Asia/Krasnoyarsk';

  var CONFIG = {
    tz: TZ,
    activeFromHour: 8,        // не раньше 8:00 по Красноярску
    activeToHour: 23.5,       // и не позже 23:30
    minSilenceMs: 40 * 60 * 1000,      // он молчит минимум 40 минут
    minGapMs: 45 * 60 * 1000,          // между её инициативами минимум 45 минут
    dailyMax: 6,                       // не больше 6 инициатив в сутки
    ignoredBackoffMs: 4 * 60 * 60 * 1000, // она написала 3 раза, он не ответил -> молчит 4 часа
    ignoredThreshold: 3,
    tickMs: 5 * 60 * 1000,
    morning: { from: 8, to: 12, silenceMs: 8 * 60 * 60 * 1000, urgency: 0.95 },
    evening: { from: 19, to: 23.5, silenceMs: 3 * 60 * 60 * 1000, urgency: 0.85 },
    casual: { silenceMs: 2 * 60 * 60 * 1000, urgency: 0.45 },
    birthdayUrgency: 1
  };

  function hourInTz(ts, tz) {
    try {
      var parts = new Intl.DateTimeFormat('ru-RU', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(new Date(ts));
      var h = 0, m = 0;
      parts.forEach(function (p) {
        if (p.type === 'hour') h = parseInt(p.value, 10) % 24;
        if (p.type === 'minute') m = parseInt(p.value, 10);
      });
      return h + m / 60;
    } catch (e) {
      var d = new Date(ts);
      return d.getHours() + d.getMinutes() / 60;
    }
  }

  function dayInTz(ts, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(ts));
    } catch (e) {
      var d = new Date(ts);
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
  }

  function loadLog(ls) {
    try {
      var raw = ls && ls.getItem(LOG_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveLog(ls, arr) {
    try { if (ls) ls.setItem(LOG_KEY, JSON.stringify(arr.slice(-200))); } catch (e) { /* ignore */ }
  }

  function create(options) {
    var opts = options || {};
    var config = Object.assign({}, CONFIG, opts.config || {});
    var nowFn = opts.now || function () { return Date.now(); };
    var randomFn = opts.random || Math.random;

    var getState = opts.getState || function () { return {}; };
    var onMessage = opts.onMessage || function () {};
    var onThought = opts.onThought || function () {};
    var onSkip = opts.onSkip || function () {};
    var apiClient = opts.api || (root && root.MashaAPI);
    var ls = opts.storage || (root && root.localStorage) || null;
    var documentRef = opts.document || (root && root.document) || null;

    var timer = null;
    var running = false;
    var visibilityHandler = null;

    function dailyCount(ts) {
      var today = dayInTz(ts, config.tz);
      return loadLog(ls).filter(function (t) { return dayInTz(t, config.tz) === today; }).length;
    }

    function lastInitiativeTs() {
      var log = loadLog(ls);
      return log.length ? log[log.length - 1] : 0;
    }

    /** Сколько раз подряд она писала, а он не отвечал. */
    function ignoredStreak(st) {
      var log = loadLog(ls);
      var lastUser = st.lastUserMessageTime || 0;
      var streak = 0;
      for (var i = log.length - 1; i >= 0; i--) {
        if (log[i] > lastUser) streak++;
        else break;
      }
      return streak;
    }

    function isEventToday(st, ts) {
      var today = dayInTz(ts, config.tz).slice(5); // MM-DD
      var events = st.events || [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (!e) continue;
        var mmdd = null;
        if (typeof e.month === 'number' && typeof e.day === 'number') {
          mmdd = ('0' + e.month).slice(-2) + '-' + ('0' + e.day).slice(-2);
        } else if (e.date) {
          var m = String(e.date).match(/(\d{2})-(\d{2})$/);
          if (m) mmdd = m[1] + '-' + m[2];
        }
        if (mmdd && mmdd === today) return true;
      }
      return false;
    }

    /** Можно ли вообще пытаться сейчас. Возвращает {ok, reason, urgency}. */
    function shouldAttempt(st, ts) {
      ts = ts || nowFn();
      st = st || getState();

      if (st.userStatus === 'sleeping') return { ok: false, reason: 'он спит' };

      var hour = hourInTz(ts, config.tz);
      if (hour < config.activeFromHour || hour >= config.activeToHour) {
        return { ok: false, reason: 'ночь, не пишу' };
      }

      var sinceUser = (st.lastUserMessageTime || 0) ? ts - st.lastUserMessageTime : Infinity;
      var sinceMasha = (st.lastMashaMessageTime || 0) ? ts - st.lastMashaMessageTime : Infinity;

      if (sinceUser < config.minSilenceMs) return { ok: false, reason: 'мы только что общались' };
      if (sinceMasha < config.minGapMs) return { ok: false, reason: 'я недавно писала' };
      if (dailyCount(ts) >= config.dailyMax) return { ok: false, reason: 'на сегодня хватит' };

      var streak = ignoredStreak(st);
      if (streak >= config.ignoredThreshold && sinceMasha < config.ignoredBackoffMs) {
        return { ok: false, reason: 'он не отвечает, подожду' };
      }

      var urgency = config.casual.urgency;
      var trigger = 'просто';

      if (isEventToday(st, ts)) {
        urgency = config.birthdayUrgency;
        trigger = 'праздник';
      } else if (hour >= config.morning.from && hour < config.morning.to && sinceUser >= config.morning.silenceMs) {
        urgency = config.morning.urgency;
        trigger = 'утро';
      } else if (hour >= config.evening.from && hour < config.evening.to && sinceUser >= config.evening.silenceMs) {
        urgency = config.evening.urgency;
        trigger = 'вечер';
      } else if (sinceUser >= config.casual.silenceMs) {
        urgency = config.casual.urgency;
        trigger = 'скучаю';
      } else {
        return { ok: false, reason: 'нет повода' };
      }

      return { ok: true, reason: trigger, urgency: urgency, sinceUserMs: sinceUser, hour: hour };
    }

    function buildStateForApi(st) {
      return {
        messages: (st.messages || []).slice(-8),
        currentState: st.currentState,
        events: (st.events || []).slice(-5),
        lastThought: st.lastThought || '',
        lastUserMessageTime: st.lastUserMessageTime || 0,
        lastMashaMessageTime: st.lastMashaMessageTime || 0,
        userStatus: st.userStatus || 'awake',
        relationship: st.relationship,
        archiveHits: (st.archiveHits || []).slice(0, 3)
      };
    }

    function notify(title, body) {
      var w = root;
      if (!w || !w.Notification) return false;
      try {
        if (w.Notification.permission === 'granted') {
          var n = new w.Notification(title || 'Маша', { body: body || '', tag: 'masha-initiative' });
          if (n && typeof n.onclick === 'function') n.onclick = function () { w.focus(); };
          return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    }

    function tick(manual) {
      if (running) return Promise.resolve({ sent: false, reason: 'уже проверяю' });
      var ts = nowFn();
      var st = getState();
      var decision = shouldAttempt(st, ts);

      if (!decision.ok) {
        onSkip(decision.reason);
        return Promise.resolve({ sent: false, reason: decision.reason });
      }
      if (!manual && randomFn() > decision.urgency) {
        onSkip('повод слабый (' + decision.reason + ')');
        return Promise.resolve({ sent: false, reason: 'повод слабый' });
      }
      if (!apiClient || typeof apiClient.initiative !== 'function') {
        return Promise.resolve({ sent: false, reason: 'нет клиента API' });
      }

      running = true;
      return apiClient.initiative(buildStateForApi(st)).then(function (data) {
        running = false;
        if (data && data.initiative && data.text) {
          var text = String(data.text).trim();
          if (!text) return { sent: false, reason: 'пустой текст' };
          var log = loadLog(ls);
          log.push(ts);
          saveLog(ls, log);
          onMessage(text, { trigger: decision.reason, endpoint: data.__endpoint });
          var hidden = documentRef && documentRef.hidden;
          if (hidden) notify('Маша', text);
          return { sent: true, text: text, trigger: decision.reason };
        }
        var reason = (data && (data.reason || data.message)) || 'не захотела';
        onThought(reason);
        return { sent: false, reason: reason };
      }).catch(function (err) {
        running = false;
        var reason = (err && (err.friendly || err.message)) || 'ошибка запроса';
        onThought('не смогла написать: ' + reason);
        return { sent: false, reason: reason, error: true };
      });
    }

    function start() {
      stop();
      timer = setInterval(function () { tick(false); }, config.tickMs);
      setTimeout(function () { tick(false); }, 8000);
      if (documentRef && documentRef.addEventListener && !visibilityHandler) {
        visibilityHandler = function () {
          if (!documentRef.hidden) tick(false);
        };
        documentRef.addEventListener('visibilitychange', visibilityHandler);
      }
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (visibilityHandler && documentRef && documentRef.removeEventListener) {
        documentRef.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
      return true;
    }

    function status() {
      var st = getState();
      var ts = nowFn();
      var d = shouldAttempt(st, ts);
      return {
        allowed: d.ok,
        reason: d.reason,
        urgency: d.urgency,
        todayCount: dailyCount(ts),
        dailyMax: config.dailyMax,
        lastInitiativeTs: lastInitiativeTs(),
        nextAllowedInMs: Math.max(0, Math.min(
          config.minGapMs - (ts - (st.lastMashaMessageTime || 0)),
          config.minSilenceMs - (ts - (st.lastUserMessageTime || 0))
        )),
        config: config
      };
    }

    function resetLog() { saveLog(ls, []); return true; }

    return {
      config: config,
      shouldAttempt: shouldAttempt,
      tick: tick,
      start: start,
      stop: stop,
      status: status,
      notify: notify,
      resetLog: resetLog,
      dailyCount: function () { return dailyCount(nowFn()); },
      ignoredStreak: function () { return ignoredStreak(getState()); }
    };
  }

  return {
    CONFIG: CONFIG,
    create: create,
    hourInTz: hourInTz,
    dayInTz: dayInTz
  };
});
