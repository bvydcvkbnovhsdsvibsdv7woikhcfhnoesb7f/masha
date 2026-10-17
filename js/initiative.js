/* MashaInitiative — «Маша пишет первой»: расписание, поводы, лимиты, уведомления.
   UMD: window.MashaInitiative / module.exports. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaInitiative = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LOG_KEY = 'masha_initiative_log';

  var CONFIG = {
    tz: 'Asia/Krasnoyarsk',
    activeFromHour: 8,
    activeToHour: 23.5,
    minSilenceMs: 40 * 60 * 1000,
    minGapMs: 45 * 60 * 1000,
    dailyMax: 6,
    ignoredBackoffMs: 4 * 60 * 60 * 1000,
    ignoredThreshold: 3,
    tickMs: 5 * 60 * 1000,
    morning: { from: 8, to: 12, silenceMs: 8 * 60 * 60 * 1000, urgency: 0.95 },
    evening: { from: 19, to: 23.5, silenceMs: 3 * 60 * 60 * 1000, urgency: 0.85 },
    casual: { silenceMs: 2 * 60 * 60 * 1000, urgency: 0.45 },
    eventUrgency: 1
  };

  function hourInTz(ts, tz) {
    try {
      var parts = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
      var h = 0, m = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') h = parseInt(parts[i].value, 10) % 24;
        if (parts[i].type === 'minute') m = parseInt(parts[i].value, 10);
      }
      return h + m / 60;
    } catch (e) {
      var d = new Date(ts);
      return d.getHours() + d.getMinutes() / 60;
    }
  }

  function dayInTz(ts, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
    } catch (e) {
      var d = new Date(ts);
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
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

    var timer = null, running = false, visibilityHandler = null;

    function loadLog() {
      try {
        var raw = ls && ls.getItem(LOG_KEY);
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }

    function saveLog(arr) {
      try { if (ls) ls.setItem(LOG_KEY, JSON.stringify(arr.slice(-200))); } catch (e) { /* ignore */ }
    }

    function dailyCount(ts) {
      var today = dayInTz(ts, config.tz);
      return loadLog().filter(function (t) { return dayInTz(t, config.tz) === today; }).length;
    }

    function ignoredStreak(st) {
      var log = loadLog();
      var lastUser = st.lastUserMessageTime || 0;
      var streak = 0;
      for (var i = log.length - 1; i >= 0; i--) {
        if (log[i] > lastUser) streak++; else break;
      }
      return streak;
    }

    function isEventToday(st, ts) {
      var today = dayInTz(ts, config.tz).slice(5);
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

    function shouldAttempt(st, ts) {
      ts = ts || nowFn();
      st = st || getState();
      if (st.userStatus === 'sleeping') return { ok: false, reason: 'он спит' };

      var hour = hourInTz(ts, config.tz);
      if (hour < config.activeFromHour || hour >= config.activeToHour) return { ok: false, reason: 'ночь, не пишу' };

      var sinceUser = (st.lastUserMessageTime || 0) ? ts - st.lastUserMessageTime : Infinity;
      var sinceMasha = (st.lastMashaMessageTime || 0) ? ts - st.lastMashaMessageTime : Infinity;

      if (sinceUser < config.minSilenceMs) return { ok: false, reason: 'мы только что общались' };
      if (sinceMasha < config.minGapMs) return { ok: false, reason: 'я недавно писала' };
      if (dailyCount(ts) >= config.dailyMax) return { ok: false, reason: 'на сегодня хватит' };

      if (ignoredStreak(st) >= config.ignoredThreshold && sinceMasha < config.ignoredBackoffMs) {
        return { ok: false, reason: 'он не отвечает, подожду' };
      }

      var urgency = config.casual.urgency;
      var trigger = 'скучаю';

      if (isEventToday(st, ts)) { urgency = config.eventUrgency; trigger = 'праздник'; }
      else if (hour >= config.morning.from && hour < config.morning.to && sinceUser >= config.morning.silenceMs) { urgency = config.morning.urgency; trigger = 'утро'; }
      else if (hour >= config.evening.from && hour < config.evening.to && sinceUser >= config.evening.silenceMs) { urgency = config.evening.urgency; trigger = 'вечер'; }
      else if (sinceUser >= config.casual.silenceMs) { urgency = config.casual.urgency; trigger = 'скучаю'; }
      else return { ok: false, reason: 'нет повода' };

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
        relationship: st.relationship
      };
    }

    function notify(title, body) {
      var w = root;
      // приложение само умеет показывать уведомления (через Service Worker на телефоне) —
      // используем его, если оно доступно
      try {
        if (w && typeof w.notifyHer === 'function') return !!w.notifyHer(title || 'Маша', body || '');
      } catch (e) { /* ignore */ }
      if (!w || !w.Notification) return false;
      try {
        if (w.Notification.permission === 'granted') {
          new w.Notification(title || 'Маша', { body: body || '', tag: 'masha-initiative' });
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
          var log = loadLog();
          log.push(ts);
          saveLog(log);
          onMessage(text, { trigger: decision.reason, endpoint: data.__endpoint });
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
        visibilityHandler = function () { if (!documentRef.hidden) tick(false); };
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
        config: config
      };
    }

    return {
      config: config,
      shouldAttempt: shouldAttempt,
      tick: tick,
      start: start,
      stop: stop,
      status: status,
      notify: notify,
      dailyCount: function () { return dailyCount(nowFn()); },
      ignoredStreak: function () { return ignoredStreak(getState()); },
      resetLog: function () { saveLog([]); return true; }
    };
  }

  return { CONFIG: CONFIG, create: create, hourInTz: hourInTz, dayInTz: dayInTz };
});
