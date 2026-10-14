/* MashaAPI — надёжный клиент релея: проверка JSON, таймауты, переключение серверов.
   UMD: window.MashaAPI / module.exports. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaAPI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var ENDPOINTS_KEY = 'masha_endpoints';
  var STATS_KEY = 'masha_api_stats';
  var LAST_OK_KEY = 'masha_last_ok_endpoint';

  var DEFAULTS = {
    timeoutMs: 25000,
    visionTimeoutMs: 45000,
    initiativeTimeoutMs: 20000,
    cooldownMs: 10 * 60 * 1000,
    deadCooldownMs: 60 * 60 * 1000,
    healthTimeoutMs: 6000,
    maxBodyLog: 180
  };

  var FRIENDLY = {
    offline: 'нет интернета — Маша ответит, как только связь вернётся',
    timeout: 'сервер не ответил вовремя, попробуй ещё раз',
    bad_json: 'сервер вернул не JSON (похоже, страница-заглушка вместо релея)',
    bad_shape: 'сервер ответил неожиданным форматом',
    http_401: 'ключ API не принят сервером',
    http_403: 'сервер отклонил запрос',
    http_404: 'на этом адресе нет релея (статический хостинг вроде GitHub Pages серверный код запускать не умеет)',
    http_429: 'слишком много запросов, подожди немного',
    http_500: 'на сервере произошла ошибка',
    http_502: 'сервер недоступен',
    http_503: 'сервер перегружен',
    network: 'не удалось соединиться с сервером (адрес указан неверно, воркер не опубликован или адрес заблокирован провайдером)',
    no_endpoints: 'не настроен адрес сервера (Настройки → Серверы)',
    all_failed: 'все серверы недоступны'
  };

  var state = { endpoints: [], cooldown: {}, stats: {}, onLog: null };

  function storage() {
    try { return root && root.localStorage ? root.localStorage : null; } catch (e) { return null; }
  }

  function nowMs() { return Date.now(); }

  function log() {
    if (typeof state.onLog === 'function') {
      try { state.onLog(Array.prototype.join.call(arguments, ' ')); } catch (e) { /* ignore */ }
    }
    if (root && root.console) root.console.log.apply(root.console, ['[MashaAPI]'].concat(Array.prototype.slice.call(arguments)));
  }

  function friendlyMessage(code, extra) {
    if (code && FRIENDLY[code]) return FRIENDLY[code];
    if (code && String(code).indexOf('deepseek_') === 0) {
      if (String(code).indexOf('timeout') !== -1) return 'AI не ответил вовремя — попробуй ещё раз';
      if (String(code).indexOf('unreachable') !== -1) return 'сервер не смог дозвониться до AI';
      if (String(code).indexOf('bad_response') !== -1) return 'AI вернул непонятный ответ';
      if (String(code).indexOf('empty') !== -1) return 'AI ответил пустотой';
      return 'AI-сервер сейчас не отвечает — попробуй ещё раз чуть позже';
    }
    if (extra && extra.status) return 'ошибка сервера (' + extra.status + ')';
    return 'что-то пошло не так, попробуй ещё раз';
  }

  function ApiError(code, message, extra) {
    var err = new Error(message || code);
    err.name = 'MashaApiError';
    err.code = code;
    err.friendly = friendlyMessage(code, extra);
    if (extra) {
      err.status = extra.status;
      err.endpoint = extra.endpoint;
      err.detail = extra.detail;
    }
    return err;
  }

  function normalizeEndpoint(url) {
    if (!url) return '';
    url = String(url).trim();
    if (!url) return '';
    if (url.charAt(0) === '/') {
      var origin = (root && root.location && root.location.origin) || '';
      return origin ? origin + url : url;
    }
    if (!/^https?:\/\//i.test(url)) return 'https://' + url;
    return url;
  }

  /* Статический хостинг (GitHub Pages, file://) не умеет серверный код:
     свой /api/relay там заведомо мёртвый — не подставляем и не ждём его. */
  function isStaticHost() {
    var loc = root && root.location;
    if (!loc) return true;
    if (loc.protocol === 'file:') return true;
    var host = String(loc.hostname || '').toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    return /\.(github|gitlab|gitee|bitbucket)\.io$/.test(host) || /\.neocities\.org$/.test(host) || /\.surge\.sh$/.test(host);
  }

  function loadEndpoints() {
    var stored = null;
    var ls = storage();
    if (ls) {
      try {
        var raw = ls.getItem(ENDPOINTS_KEY);
        if (raw) stored = JSON.parse(raw);
      } catch (e) { stored = null; }
    }
    if (!Array.isArray(stored) || !stored.length) {
      stored = ((root && root.MASHA_DEFAULT_ENDPOINTS) || []).slice();
      if (!isStaticHost()) stored.unshift('/api/relay');
    }
    var seen = {};
    var list = [];
    var sameOrigin = normalizeEndpoint('/api/relay');
    for (var i = 0; i < stored.length; i++) {
      var u = normalizeEndpoint(stored[i]);
      if (!u || seen[u]) continue;
      if (isStaticHost() && u === sameOrigin) continue;   // чистим мёртвый адрес из старого списка
      seen[u] = true;
      list.push(u);
    }
    state.endpoints = list;
    return list;
  }

  function getEndpoints() {
    if (!state.endpoints.length) loadEndpoints();
    return state.endpoints.slice();
  }

  function setEndpoints(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (u) {
      var n = normalizeEndpoint(u);
      if (n && !seen[n]) { seen[n] = true; out.push(n); }
    });
    state.endpoints = out;
    var ls = storage();
    if (ls) { try { ls.setItem(ENDPOINTS_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ } }
    return out;
  }

  function loadStats() {
    var ls = storage();
    if (!ls) return state.stats;
    try {
      var raw = ls.getItem(STATS_KEY);
      if (raw) state.stats = JSON.parse(raw) || {};
    } catch (e) { state.stats = {}; }
    return state.stats;
  }

  function saveStats() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(STATS_KEY, JSON.stringify(state.stats)); } catch (e) { /* ignore */ }
  }

  function lastOkEndpoint() {
    var ls = storage();
    if (!ls) return '';
    try { return ls.getItem(LAST_OK_KEY) || ''; } catch (e) { return ''; }
  }

  function rememberOk(url) {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(LAST_OK_KEY, url); } catch (e) { /* ignore */ }
  }

  function markOk(url, latencyMs) {
    loadStats();
    var s = state.stats[url] || { ok: 0, fail: 0 };
    s.ok++;
    s.lastOk = nowMs();
    s.lastLatencyMs = latencyMs;
    s.lastError = null;
    state.stats[url] = s;
    saveStats();
    delete state.cooldown[url];
    rememberOk(url);
  }

  function markFail(url, err) {
    loadStats();
    var s = state.stats[url] || { ok: 0, fail: 0 };
    s.fail++;
    s.lastFail = nowMs();
    s.lastError = (err && err.code ? err.code : 'error') + (err && err.status ? ' ' + err.status : '');
    state.stats[url] = s;
    saveStats();
    var dead = err && (err.code === 'http_404' || err.code === 'http_403' || err.code === 'bad_json');
    state.cooldown[url] = nowMs() + (dead ? DEFAULTS.deadCooldownMs : DEFAULTS.cooldownMs);
  }

  function isCoolingDown(url) {
    var until = state.cooldown[url];
    return !!until && until > nowMs();
  }

  function cooldownLeftMs(url) {
    var until = state.cooldown[url];
    return until && until > nowMs() ? until - nowMs() : 0;
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    var supportsAbort = typeof root.AbortController === 'function';
    var controller = supportsAbort ? new root.AbortController() : null;
    var timer = null;
    var opts = options || {};
    if (controller) opts.signal = controller.signal;

    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
        reject(ApiError('timeout', 'timeout', { endpoint: url }));
      }, timeoutMs);
    });

    var fetchPromise = Promise.resolve().then(function () {
      if (typeof root.fetch !== 'function') throw ApiError('network', 'fetch is not available');
      return root.fetch(url, opts);
    });

    return Promise.race([fetchPromise, timeoutPromise]).then(function (res) {
      clearTimeout(timer);
      return res;
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'MashaApiError') throw err;
      if (err && (err.name === 'AbortError' || err.code === 20)) throw ApiError('timeout', 'aborted', { endpoint: url });
      throw ApiError('network', String((err && err.message) || err), { endpoint: url });
    });
  }

  function readJsonResponse(res, endpoint) {
    var ct = '';
    try { ct = (res.headers && res.headers.get && res.headers.get('content-type')) || ''; } catch (e) { ct = ''; }
    return res.text().then(function (text) {
      var looksJson = ct.indexOf('json') !== -1;
      var trimmed = String(text || '').trim();
      if (!looksJson && /^</.test(trimmed)) {
        throw ApiError(res.ok ? 'bad_json' : ('http_' + res.status),
          res.ok ? 'html instead of json' : 'html error page',
          { endpoint: endpoint, status: res.status, detail: trimmed.slice(0, DEFAULTS.maxBodyLog) });
      }
      var data;
      try { data = trimmed ? JSON.parse(trimmed) : null; } catch (e) {
        throw ApiError('bad_json', 'json parse failed', { endpoint: endpoint, status: res.status, detail: trimmed.slice(0, DEFAULTS.maxBodyLog) });
      }
      if (!data || typeof data !== 'object') throw ApiError('bad_shape', 'empty json', { endpoint: endpoint, status: res.status });
      if (!res.ok) {
        // Релей отвечает на свои проблемы HTTP 500 + JSON {ok:false,...} — это не
        // сломанный адрес, а сообщение. Отдаём его наверх, чтобы клиент мог
        // переключиться на другой сервер или показать мягкую фразу Маши.
        if (data.ok === false) return data;
        var err = ApiError('http_' + res.status, String(data.message || data.error || ('HTTP ' + res.status)), { endpoint: endpoint, status: res.status });
        err.payload = data;
        throw err;
      }
      return data;
    });
  }

  function postTo(endpoint, payload, timeoutMs) {
    var started = nowMs();
    return fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    }, timeoutMs).then(function (res) {
      return readJsonResponse(res, endpoint).then(function (data) {
        markOk(endpoint, nowMs() - started);
        data.__endpoint = endpoint;
        data.__latencyMs = nowMs() - started;
        return data;
      });
    }).catch(function (err) {
      markFail(endpoint, err);
      throw err;
    });
  }

  function isOffline() {
    var nav = root && root.navigator;
    return !!nav && nav.onLine === false;
  }

  function runOverEndpoints(builder, options) {
    var opts = options || {};
    var endpoints = opts.endpoints && opts.endpoints.length ? opts.endpoints.slice() : getEndpoints();
    if (!endpoints.length) return Promise.reject(ApiError('no_endpoints'));
    if (isOffline()) return Promise.reject(ApiError('offline'));

    var order = endpoints.filter(function (u) { return !isCoolingDown(u); })
      .concat(endpoints.filter(isCoolingDown));

    var sticky = lastOkEndpoint();
    if (sticky) {
      var idx = order.indexOf(sticky);
      if (idx > 0) { order.splice(idx, 1); order.unshift(sticky); }
    }

    var attempt = function (index, lastErr) {
      if (index >= order.length) {
        if (lastErr) {
          var err = ApiError(lastErr.code || 'all_failed', lastErr.message || 'all endpoints failed', {
            endpoint: lastErr.endpoint, status: lastErr.status
          });
          err.friendly = lastErr.friendly || FRIENDLY.all_failed;
          err.tried = order.slice();
          err.cause = lastErr.code;
          throw err;
        }
        throw ApiError('all_failed');
      }
      var endpoint = order[index];
      return postTo(endpoint, builder(endpoint), opts.timeoutMs || DEFAULTS.timeoutMs).then(function (data) {
        if (typeof opts.validate === 'function') {
          var problem = opts.validate(data);
          if (problem) {
            var verr = ApiError('bad_shape', problem, { endpoint: endpoint });
            markFail(endpoint, verr);
            return attempt(index + 1, verr);
          }
        }
        return data;
      }, function (err) {
        log('endpoint failed:', endpoint, err.code || err.message);
        return attempt(index + 1, err);
      });
    };
    return attempt(0, null);
  }

  /* Чат. Если сервер ответил ошибкой (ok:false) — это чаще всего ЕГО проблема
     (нет ключа, сбой модели), поэтому пробуем следующий адрес. Если все ответили
     ошибкой, показываем мягкую фразу Маши, а не технический текст. */
  function chat(payload) {
    var timeout = payload && payload.image ? DEFAULTS.visionTimeoutMs : DEFAULTS.timeoutMs;
    var soft = null;
    return runOverEndpoints(function () { return payload; }, {
      timeoutMs: timeout,
      validate: function (data) {
        if (data && data.ok === false) {
          soft = data;
          return 'сервер вернул ошибку: ' + (data.error || 'server_error');
        }
        if (typeof data.reply === 'string' && data.reply.trim()) return null;
        return 'нет поля reply';
      }
    }).then(function (data) {
      if (data.ok === false) {
        if (typeof data.reply === 'string' && data.reply.trim()) {
          data.__softError = data.error || 'server_error';
          data.__softMessage = data.message || friendlyMessage(data.__softError);
          return data;
        }
        throw ApiError(data.error || 'server_error', data.message || 'server error', { endpoint: data.__endpoint });
      }
      return data;
    }).catch(function (err) {
      // Все адреса ответили ошибкой — отдаём последнюю мягкую фразу релея.
      if (soft && typeof soft.reply === 'string' && soft.reply.trim()) {
        soft.__softError = soft.error || (err && err.code) || 'all_failed';
        soft.__softMessage = soft.message || friendlyMessage(soft.__softError);
        return soft;
      }
      throw err;
    });
  }

  function initiative(st) {
    return runOverEndpoints(function () { return { checkInitiative: true, state: st }; }, {
      timeoutMs: DEFAULTS.initiativeTimeoutMs,
      validate: function (data) {
        if (data.ok === false) return null;
        if (typeof data.initiative === 'boolean') return null;
        if (typeof data.reason === 'string' || typeof data.text === 'string') return null;
        return 'нет поля initiative';
      }
    });
  }

  function health(endpoint, timeoutMs) {
    var url = normalizeEndpoint(endpoint);
    var started = nowMs();
    var limit = timeoutMs || DEFAULTS.healthTimeoutMs;
    return fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, limit)
      .then(function (res) { return readJsonResponse(res, url); })
      .catch(function (err) {
        // Бывает, что по адресу живёт ещё и сайт: GET отдаёт HTML страницы, а сам
        // релей отвечает только на POST. Тогда проверяем его POST-запросом.
        if (err && (err.code === 'bad_json' || err.code === 'http_404' || err.code === 'http_405')) {
          return fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ health: true })
          }, limit).then(function (res2) { return readJsonResponse(res2, url); });
        }
        throw err;
      })
      .then(function (data) {
        var out = { endpoint: url, ok: true, latencyMs: nowMs() - started, data: data };
        if (data && data.ok === false) {
          out.ok = false;
          out.code = data.error || 'soft_error';
          out.friendly = data.message || data.reply || 'релей ответил ошибкой';
        }
        markOk(url, out.latencyMs);
        return out;
      })
      .catch(function (err) {
        markFail(url, err);
        return { endpoint: url, ok: false, latencyMs: nowMs() - started, code: err.code, error: err.message, friendly: err.friendly };
      });
  }

  function healthAll(timeoutMs) {
    return Promise.all(getEndpoints().map(function (u) { return health(u, timeoutMs); }));
  }

  function getStats() {
    loadStats();
    return { endpoints: getEndpoints(), stats: JSON.parse(JSON.stringify(state.stats)) };
  }

  function resetCooldowns() { state.cooldown = {}; }

  function status() {
    var eps = getEndpoints();
    var alive = [], dead = [];
    for (var i = 0; i < eps.length; i++) {
      if (cooldownLeftMs(eps[i]) > 0) dead.push(eps[i]); else alive.push(eps[i]);
    }
    return {
      endpoints: eps, available: alive, cooling: dead,
      lastOk: lastOkEndpoint(),
      allDead: eps.length > 0 && alive.length === 0,
      noEndpoints: eps.length === 0
    };
  }

  function configure(opts) {
    opts = opts || {};
    if (opts.endpoints) setEndpoints(opts.endpoints);
    if (typeof opts.onLog === 'function') state.onLog = opts.onLog;
  }

  return {
    DEFAULTS: DEFAULTS,
    ApiError: ApiError,
    friendlyMessage: friendlyMessage,
    normalizeEndpoint: normalizeEndpoint,
    isStaticHost: isStaticHost,
    configure: configure,
    getEndpoints: getEndpoints,
    setEndpoints: setEndpoints,
    loadEndpoints: loadEndpoints,
    chat: chat,
    initiative: initiative,
    health: health,
    healthAll: healthAll,
    getStats: getStats,
    status: status,
    lastOkEndpoint: lastOkEndpoint,
    resetCooldowns: resetCooldowns,
    cooldownLeftMs: cooldownLeftMs,
    isOffline: isOffline
  };
});
