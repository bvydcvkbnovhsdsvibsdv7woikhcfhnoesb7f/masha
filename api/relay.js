/**
 * masha-fixed / api/relay.js
 * Vercel serverless-релей к DeepSeek для приложения «Маша».
 *
 * ГЛАВНОЕ ПРАВИЛО: этот обработчик ВСЕГДА отвечает валидным JSON
 * (Content-Type: application/json; charset=utf-8) и НИКОГДА не отдаёт HTML,
 * стектрейс или пустое тело. Именно HTML-ответ ломал приложение
 * ошибкой «Unexpected token '<', "<!DOCTYPE" ... is not valid JSON».
 *
 * Контракт (INTERFACES.md § 4.1):
 *   GET     /api/relay         -> 200 {ok:true, service, version, hasKey, ...}   (диагностика)
 *   OPTIONS /api/relay         -> 204 + CORS
 *   POST    /api/relay         -> 200 {ok:true, reply, thought}
 *                              -> 200 {ok:true, initiative, text|reason}
 *                              -> 200 {ok:false, error, message, reply}   (мягкая ошибка для фронта)
 *                              -> 400 {ok:false, error:'bad_json', ...}
 *                              -> 405 {ok:false, error:'method_not_allowed', ...}
 *                              -> 500 {ok:false, error:'no_api_key', ...}
 *
 * Ключ берётся только из окружения: DEEPSEEK_API_KEY (или алиас DEEPSEEK_KEY).
 */

export const VERSION = '2.0.0';
export const SERVICE = 'masha-relay';

/* Мягкая фраза Маши (lowercase, без эмодзи) — фронт показывает её как её сообщение. */
export const SOFT_REPLY = 'блин, у меня чето связь пропала, давай еще раз?';

/** CORS выставляем ровно один раз, вместе с Content-Type. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store'
};

/** Дефолты времени ожидания (переопределяются через RELAY_TIMEOUT_MS). */
const TIMEOUT_DEFAULT_MS = 30000;
const TIMEOUT_MAX_MS = 120000;

/* ------------------------------------------------------------------ helpers */

/** Единственная точка отправки JSON в Vercel-стиле. Заголовки ставятся ровно один раз. */
export function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj === undefined ? {} : obj);
  try {
    if (res && typeof res.setHeader === 'function') {
      for (const k of Object.keys(CORS_HEADERS)) res.setHeader(k, CORS_HEADERS[k]);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  } catch (e) {
    console.error('[relay] setHeader failed:', e);
  }
  try {
    if (res && typeof res.status === 'function') {
      const chain = res.status(status);
      if (chain && typeof chain.json === 'function') return chain.json(obj === undefined ? {} : obj);
      if (chain && typeof chain.send === 'function') return chain.send(payload);
      if (chain && typeof chain.end === 'function') return chain.end(payload);
      return chain;
    }
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
      if (typeof res.end === 'function') return res.end(payload);
    }
  } catch (e) {
    // Второй раз заголовки не ставим: молча логируем, чтобы не получить ERR_HTTP_HEADERS_SENT.
    console.error('[relay] response failed:', e);
  }
  return undefined;
}

/** Мягкая ошибка в формате контракта. */
export function softError(error, message, reply) {
  return {
    ok: false,
    error: String(error || 'server_error'),
    message: String(message || 'что-то пошло не так на сервере'),
    reply: typeof reply === 'string' && reply.trim() ? reply : SOFT_REPLY
  };
}

/** Ошибка запроса к DeepSeek -> код вида deepseek_<status>. */
export function errorFromFailure(failure) {
  const f = failure || {};
  if (f.status && Number.isFinite(Number(f.status))) {
    return { error: 'deepseek_' + Number(f.status), message: 'deepseek ответил ошибкой ' + Number(f.status) + ', попробуем еще раз' };
  }
  if (f.kind === 'timeout') return { error: 'deepseek_timeout', message: 'deepseek не ответил вовремя, попробуем еще раз' };
  if (f.kind === 'bad_body') return { error: 'deepseek_bad_response', message: 'deepseek ответил не тем, что мы ждали' };
  if (f.kind === 'empty') return { error: 'deepseek_empty', message: 'deepseek ответил пустотой, попробуем еще раз' };
  return { error: 'deepseek_unreachable', message: 'не получилось связаться с deepseek, попробуем еще раз' };
}

/* -------------------------------------------------------------- config/env */

function readEnv(env, name) {
  if (!env) return undefined;
  try {
    const v = env[name];
    return v === undefined || v === null ? undefined : v;
  } catch (e) {
    return undefined;
  }
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Собирает конфигурацию релея из переменных окружения (Vercel) или env-биндингов воркера. */
export function getConfig(env) {
  const src = env && typeof env === 'object' ? env : {};
  const key = clean(readEnv(src, 'DEEPSEEK_API_KEY')) || clean(readEnv(src, 'DEEPSEEK_KEY'));
  const parsedTimeout = Number(clean(readEnv(src, 'RELAY_TIMEOUT_MS')));
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? Math.min(parsedTimeout, TIMEOUT_MAX_MS)
    : TIMEOUT_DEFAULT_MS;
  const thoughtsFlag = clean(readEnv(src, 'DEEPSEEK_THOUGHTS')).toLowerCase();
  return {
    key,
    hasKey: !!key,
    baseUrl: clean(readEnv(src, 'DEEPSEEK_BASE_URL')) || 'https://api.deepseek.com/chat/completions',
    textModel: clean(readEnv(src, 'DEEPSEEK_TEXT_MODEL')) || 'deepseek-flash',
    visionModel: clean(readEnv(src, 'DEEPSEEK_VISION_MODEL')) || 'deepseek-v4.1-flash',
    timeoutMs,
    thoughts: !(thoughtsFlag === '0' || thoughtsFlag === 'false' || thoughtsFlag === 'off' || thoughtsFlag === 'no')
  };
}

/* ------------------------------------------------------------ request body */

/**
 * Достаёт тело запроса и парсит его.
 * req.body может быть объектом (Vercel часто уже распарсил), строкой, Buffer и т.п.
 * Возвращает {ok:true, body} либо {ok:false, code:'bad_json'|'json_object_required'}.
 */
export async function parseRequestBody(req) {
  let raw = req ? req.body : undefined;

  // тело ещё не прочитано — читаем поток (или строку, если это уже текст)
  if (raw === undefined || raw === null || raw === '') {
    if (req && typeof req[Symbol.asyncIterator] === 'function') {
      try {
        let text = '';
        for await (const chunk of req) text += typeof chunk === 'string' ? chunk : String(chunk);
        raw = text;
      } catch (e) {
        return { ok: false, code: 'bad_json', detail: 'не удалось прочитать тело запроса' };
      }
    }
  }

  if (raw === undefined || raw === null) return { ok: false, code: 'bad_json', detail: 'тело запроса пустое' };

  // Buffer / Uint8Array / любой объект с toString
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && raw.constructor && (raw.constructor.name === 'Buffer' || raw.constructor.name === 'Uint8Array')) {
      raw = String(raw);
    } else if (typeof raw === 'object' && !Array.isArray(raw)) {
      // Vercel уже отдал объект — это валидное тело
      return { ok: true, body: raw };
    } else if (typeof raw === 'object' && Array.isArray(raw)) {
      return { ok: false, code: 'json_object_required', detail: 'ожидался объект JSON' };
    } else {
      raw = String(raw);
    }
  }

  const text = raw.trim();
  if (!text) return { ok: false, code: 'bad_json', detail: 'тело запроса пустое' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'bad_json', detail: 'не удалось разобрать JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'json_object_required', detail: 'ожидался объект JSON' };
  }
  return { ok: true, body: parsed };
}

/* ------------------------------------------------------------------- DeepSeek */

/** Один запрос к DeepSeek. Никогда не бросает — возвращает {ok:false, kind, status}. */
export async function askDeepSeek(messages, model, cfg, fetchImpl) {
  const conf = cfg || getConfig({});
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

  if (!doFetch) return { ok: false, kind: 'no_fetch' };
  if (!conf.key) return { ok: false, kind: 'no_key' };

  const supportsAbort = typeof AbortController === 'function';
  const controller = supportsAbort ? new AbortController() : null;
  let timer = null;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
        const err = new Error('relay timeout');
        err.__relayTimeout = true;
        reject(err);
      }, conf.timeoutMs);
    });

    const requestPromise = doFetch(conf.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + conf.key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: 200,
        temperature: 0.85,
        stream: false
      }),
      ...(controller ? { signal: controller.signal } : {})
    });

    const r = await Promise.race([requestPromise, timeoutPromise]);

    if (!r || typeof r !== 'object') return { ok: false, kind: 'bad_response' };
    if (!r.ok) {
      let t = '';
      try { t = String(await r.text()).slice(0, 300); } catch (e) { t = ''; }
      console.error('[relay] deepseek error:', r.status, t);
      return { ok: false, kind: 'http', status: Number(r.status) || 0, detail: t };
    }

    let data = null;
    try {
      const rawText = await r.text();
      data = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      // DeepSeek (или прокси) вернул HTML/мусор — это не повод отдавать HTML дальше.
      console.error('[relay] deepseek returned non-json body');
      return { ok: false, kind: 'bad_body' };
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (typeof content !== 'string' || !content.trim()) {
      console.error('[relay] deepseek empty content:', JSON.stringify(data).slice(0, 300));
      return { ok: false, kind: 'empty' };
    }
    return { ok: true, reply: content };
  } catch (e) {
    if (e && (e.__relayTimeout || e.name === 'AbortError')) return { ok: false, kind: 'timeout' };
    console.error('[relay] deepseek fetch failed:', e);
    return { ok: false, kind: 'network', detail: String(e && e.message || e).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ prompty */

/** Санитация истории: без пустых, без подряд одинаковых ролей, не заканчивается на user, максимум 15. */
export function sanitizeHistory(history) {
  const clean = [];
  const src = Array.isArray(history) ? history : [];
  for (const m of src) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    const rawRole = m.role === 'bot' || m.role === 'ai' || m.role === 'model' || m.role === 'assistant' ? 'assistant' : m.role;
    const role = rawRole === 'user' ? 'user' : (rawRole === 'assistant' ? 'assistant' : null);
    if (!role) continue;
    const prev = clean[clean.length - 1];
    if (prev && prev.role === role) prev.content += '\n' + m.content.trim();
    else clean.push({ role: role, content: m.content.trim() });
  }
  while (clean.length && clean[clean.length - 1].role === 'user') clean.pop();
  return clean.slice(-15);
}

export function buildInitiativePrompt(state) {
  const st = state && typeof state === 'object' ? state : {};
  let now = '';
  try {
    now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' });
  } catch (e) {
    now = new Date().toISOString();
  }
  const sinceLastUser = st.lastUserMessageTime ? Math.round((Date.now() - Number(st.lastUserMessageTime)) / 60000) : 999;
  const messages = Array.isArray(st.messages) ? st.messages : [];
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const lastText = lastMsg && typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 100) : 'ничего';

  return 'Ты Маша, 17 лет, Красноярск. Сейчас: ' + now + '. Твоё состояние: ' + (st.currentState || 'calm') +
    '. Он не писал: ' + sinceLastUser + ' мин. Он сейчас: ' + (st.userStatus || 'awake') +
    '. Последнее обсуждали: ' + lastText + '.\n' +
    'Хочешь написать ему прямо сейчас? Если да — 1 короткое предложение в твоём стиле (lowercase, без эмодзи). Если нет — почему.\n' +
    'Формат ТОЛЬКО: "ХОЧУ: <текст>" или "НЕ ХОЧУ: <причина>".';
}

export function buildThoughtPrompt(text, image, history, lastThought) {
  const src = Array.isArray(history) ? history : [];
  const hist = src.slice(-5).map((m) => {
    const role = m && m.role === 'user' ? 'Он: ' : 'Ты: ';
    const content = m && typeof m.content === 'string' ? m.content : '';
    return role + content;
  }).join('\n');

  return 'Ты Маша. Контекст:\n' + hist +
    '\nПользователь написал: ' + (text || (image ? '[фото]' : '[пусто]')) +
    '\nТвоя прошлая мысль: ' + (lastThought || 'ничего') +
    '\nНапиши ОДНУ мысль до 15 слов про себя, lowercase, не для пользователя.';
}

export function buildUserContent(text, image) {
  if (image) {
    return [
      { type: 'text', text: text || 'Отреагируй на это фото.' },
      { type: 'image_url', image_url: { url: image } }
    ];
  }
  return text || '';
}

export function buildSystemMessage(systemPrompt, thought) {
  return {
    role: 'system',
    content: String(systemPrompt || '') + '\n\nТы сейчас думаешь: ' + (thought || 'ничего особого')
  };
}

/* ------------------------------------------------------------- core handler */

function parseInitiative(reply) {
  const r = String(reply || '').trim();
  if (r.indexOf('ХОЧУ:') === 0) return { initiative: true, text: r.slice('ХОЧУ:'.length).trim() };
  if (r.indexOf('НЕ ХОЧУ:') === 0) return { initiative: false, reason: r.slice('НЕ ХОЧУ:'.length).trim() };
  return null;
}

/**
 * Вся логика релея: (body, cfg) -> {status, data}.
 * Ничего не знает про транспорт, поэтому используется и в Vercel, и в Cloudflare Worker.
 */
export async function processRequest(body, cfg, fetchImpl) {
  const conf = cfg || getConfig({});
  const reqBody = body && typeof body === 'object' ? body : {};
  const text = reqBody.text;
  const image = reqBody.image;
  const systemPrompt = reqBody.systemPrompt;
  const history = reqBody.history;
  const lastThought = reqBody.lastThought;
  const checkInitiative = reqBody.checkInitiative;

  /* === ИНИЦИАТИВА === */
  if (checkInitiative) {
    const out = await askDeepSeek(
      [{ role: 'user', content: buildInitiativePrompt(reqBody.state) }],
      conf.textModel, conf, fetchImpl
    );

    if (!out.ok) {
      const e = errorFromFailure(out);
      return {
        status: 200,
        data: Object.assign({ ok: false, initiative: false, text: '', reply: SOFT_REPLY }, e)
      };
    }

    const parsed = parseInitiative(out.reply);
    const result = parsed || { initiative: false, reason: String(out.reply).slice(0, 200) };
    return { status: 200, data: Object.assign({ ok: true }, result) };
  }

  /* === ВНУТРЕННИЙ МОНОЛОГ (можно выключить: DEEPSEEK_THOUGHTS=0) === */
  let thought = '';
  if (conf.thoughts && (text || image)) {
    const out = await askDeepSeek(
      [{ role: 'user', content: buildThoughtPrompt(text, image, history, lastThought) }],
      conf.textModel, conf, fetchImpl
    );
    if (out.ok) thought = String(out.reply).slice(0, 120).trim();
  }

  /* === ЗАПРОС К ЧАТУ: с историей, при неудаче — без истории === */
  const cleanHistory = sanitizeHistory(history);
  const userContent = buildUserContent(text, image);
  const model = image ? conf.visionModel : conf.textModel;
  const systemMsg = buildSystemMessage(systemPrompt, thought);
  const fullMessages = [systemMsg].concat(cleanHistory, [{ role: 'user', content: userContent }]);

  let out = await askDeepSeek(fullMessages, model, conf, fetchImpl);

  if (!out.ok && cleanHistory.length) {
    console.error('[relay] retry without history, reason:', out.kind, out.status || '');
    // Если и без истории не вышло — отдаём последнюю ошибку (по ней строится код deepseek_<status>).
    out = await askDeepSeek([systemMsg, { role: 'user', content: userContent }], model, conf, fetchImpl);
  }

  if (!out.ok) {
    const e = errorFromFailure(out);
    return { status: 200, data: Object.assign({ ok: false, thought: thought, reply: SOFT_REPLY }, e) };
  }

  return {
    status: 200,
    data: { ok: true, reply: String(out.reply), thought: thought }
  };
}

/** GET /api/relay — диагностика: открыл в браузере и видно, что релей жив. */
export function diagnostics(cfg) {
  const conf = cfg || getConfig({});
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    hasKey: conf.hasKey,
    models: { text: conf.textModel, vision: conf.visionModel },
    timeoutMs: conf.timeoutMs,
    thoughts: conf.thoughts,
    time: new Date().toISOString(),
    hint: conf.hasKey
      ? 'релей жив, ключ на месте. отправь POST с {text, history, systemPrompt}'
      : 'релей жив, но нет переменной окружения DEEPSEEK_API_KEY — добавь её в настройках хостинга'
  };
}

/* ------------------------------------------------------------ vercel handler */

export default async function handler(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  const cfg = getConfig(process.env);

  if (method === 'OPTIONS') {
    try {
      if (res && typeof res.setHeader === 'function') {
        for (const k of Object.keys(CORS_HEADERS)) res.setHeader(k, CORS_HEADERS[k]);
      }
    } catch (e) { console.error('[relay] options headers failed:', e); }
    try {
      if (res && typeof res.status === 'function') return res.status(204).end();
      if (res && typeof res.writeHead === 'function') { res.writeHead(204, CORS_HEADERS); return res.end(); }
    } catch (e) { console.error('[relay] options end failed:', e); }
    return undefined;
  }

  if (method === 'GET' || method === 'HEAD') {
    return sendJson(res, 200, diagnostics(cfg));
  }

  if (method !== 'POST') {
    return sendJson(res, 405, softError('method_not_allowed', 'поддерживаются только GET, POST и OPTIONS'));
  }

  const parsed = await parseRequestBody(req);
  if (!parsed.ok) {
    return sendJson(res, 400, softError(parsed.code, parsed.detail || 'некорректный JSON в теле запроса'));
  }

  if (!cfg.hasKey) {
    return sendJson(res, 500, softError('no_api_key', 'на сервере не настроен ключ DEEPSEEK_API_KEY'));
  }

  try {
    const { status, data } = await processRequest(parsed.body, cfg);
    return sendJson(res, status, data);
  } catch (e) {
    // Сюда попадать не должны, но даже тогда наружу уходит только JSON без стектрейса.
    console.error('[relay] unhandled error:', e);
    return sendJson(res, 500, softError('server_error', 'внутренняя ошибка релея'));
  }
}
