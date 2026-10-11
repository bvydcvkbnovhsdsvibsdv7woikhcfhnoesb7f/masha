/**
 * masha-fixed / worker/worker.js
 * Cloudflare Worker — РЕЗЕРВНЫЙ хост релея «Маши».
 *
 * Тот же контракт, что и у api/relay.js (Vercel): всегда валидный JSON,
 * никогда HTML и никогда стектрейс.
 *
 *   GET  /  |  GET /health  -> 200 {ok:true, service, version, hasKey, models, ...}
 *   POST /  (и любой путь)  -> 200 {ok:true, reply, thought}
 *                           -> 200 {ok:true, initiative, text|reason}
 *                           -> 200 {ok:false, error, message, reply}
 *                           -> 400 {ok:false, error:'bad_json', ...}
 *                           -> 500 {ok:false, error:'no_api_key', ...}
 *   OPTIONS (любой путь)    -> 204 + CORS
 *
 * Секрет: wrangler secret put DEEPSEEK_API_KEY
 */

const VERSION = '2.0.0';
const SERVICE = 'masha-relay';

/* Мягкая фраза Маши (lowercase, без эмодзи). */
const SOFT_REPLY = 'блин, у меня чето связь пропала, давай еще раз?';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store'
};

const TIMEOUT_DEFAULT_MS = 30000;
const TIMEOUT_MAX_MS = 120000;

/* ------------------------------------------------------------------ helpers */

/** Единственная точка отправки JSON в воркере. Заголовки ставятся ровно один раз. */
function json(status, obj) {
  return new Response(JSON.stringify(obj === undefined ? {} : obj), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS)
  });
}

function softError(error, message, reply) {
  return {
    ok: false,
    error: String(error || 'server_error'),
    message: String(message || 'что-то пошло не так на сервере'),
    reply: typeof reply === 'string' && reply.trim() ? reply : SOFT_REPLY
  };
}

function errorFromFailure(failure) {
  const f = failure || {};
  if (f.status && Number.isFinite(Number(f.status))) {
    return { error: 'deepseek_' + Number(f.status), message: 'deepseek ответил ошибкой ' + Number(f.status) + ', попробуем еще раз' };
  }
  if (f.kind === 'timeout') return { error: 'deepseek_timeout', message: 'deepseek не ответил вовремя, попробуем еще раз' };
  if (f.kind === 'bad_body') return { error: 'deepseek_bad_response', message: 'deepseek ответил не тем, что мы ждали' };
  if (f.kind === 'empty') return { error: 'deepseek_empty', message: 'deepseek ответил пустотой, попробуем еще раз' };
  return { error: 'deepseek_unreachable', message: 'не получилось связаться с deepseek, попробуем еще раз' };
}

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

function getConfig(env) {
  const src = env && typeof env === 'object' ? env : {};
  const key = clean(readEnv(src, 'DEEPSEEK_API_KEY')) || clean(readEnv(src, 'DEEPSEEK_KEY'));
  const parsedTimeout = Number(clean(readEnv(src, 'RELAY_TIMEOUT_MS')));
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? Math.min(parsedTimeout, TIMEOUT_MAX_MS)
    : TIMEOUT_DEFAULT_MS;
  const thoughtsFlag = clean(readEnv(src, 'DEEPSEEK_THOUGHTS')).toLowerCase();
  return {
    key: key,
    hasKey: !!key,
    baseUrl: clean(readEnv(src, 'DEEPSEEK_BASE_URL')) || 'https://api.deepseek.com/chat/completions',
    textModel: clean(readEnv(src, 'DEEPSEEK_TEXT_MODEL')) || 'deepseek-flash',
    visionModel: clean(readEnv(src, 'DEEPSEEK_VISION_MODEL')) || 'deepseek-v4.1-flash',
    timeoutMs: timeoutMs,
    thoughts: !(thoughtsFlag === '0' || thoughtsFlag === 'false' || thoughtsFlag === 'off' || thoughtsFlag === 'no')
  };
}

/* ------------------------------------------------------------ request body */

/** Тело запроса -> {ok:true, body} | {ok:false, code, detail}. */
async function parseRequestBody(request) {
  let text = '';
  try {
    text = await request.text();
  } catch (e) {
    return { ok: false, code: 'bad_json', detail: 'не удалось прочитать тело запроса' };
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, code: 'bad_json', detail: 'тело запроса пустое' };

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, code: 'bad_json', detail: 'не удалось разобрать JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'json_object_required', detail: 'ожидался объект JSON' };
  }
  return { ok: true, body: parsed };
}

/* ------------------------------------------------------------------ DeepSeek */

/** Один запрос к DeepSeek. Никогда не бросает. */
async function askDeepSeek(messages, model, cfg) {
  const conf = cfg || getConfig({});
  if (typeof fetch !== 'function') return { ok: false, kind: 'no_fetch' };
  if (!conf.key) return { ok: false, kind: 'no_key' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;

  try {
    const timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
        const err = new Error('relay timeout');
        err.__relayTimeout = true;
        reject(err);
      }, conf.timeoutMs);
    });

    const requestPromise = fetch(conf.baseUrl, {
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
      signal: controller ? controller.signal : undefined
    });

    const r = await Promise.race([requestPromise, timeoutPromise]);
    if (!r || typeof r !== 'object') return { ok: false, kind: 'bad_response' };

    if (!r.ok) {
      let detail = '';
      try { detail = String(await r.text()).slice(0, 300); } catch (e) { detail = ''; }
      console.error('[worker] deepseek error:', r.status, detail);
      return { ok: false, kind: 'http', status: Number(r.status) || 0, detail: detail };
    }

    let data = null;
    try {
      const raw = await r.text();
      data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('[worker] deepseek returned non-json body');
      return { ok: false, kind: 'bad_body' };
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (typeof content !== 'string' || !content.trim()) {
      console.error('[worker] deepseek empty content:', JSON.stringify(data).slice(0, 300));
      return { ok: false, kind: 'empty' };
    }
    return { ok: true, reply: content };
  } catch (e) {
    if (e && (e.__relayTimeout || e.name === 'AbortError')) return { ok: false, kind: 'timeout' };
    console.error('[worker] deepseek fetch failed:', e);
    return { ok: false, kind: 'network', detail: String((e && e.message) || e).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ prompty */

function sanitizeHistory(history) {
  const result = [];
  const src = Array.isArray(history) ? history : [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i];
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    const rawRole = (m.role === 'bot' || m.role === 'ai' || m.role === 'model' || m.role === 'assistant') ? 'assistant' : m.role;
    const role = rawRole === 'user' ? 'user' : (rawRole === 'assistant' ? 'assistant' : null);
    if (!role) continue;
    const prev = result[result.length - 1];
    if (prev && prev.role === role) prev.content += '\n' + m.content.trim();
    else result.push({ role: role, content: m.content.trim() });
  }
  while (result.length && result[result.length - 1].role === 'user') result.pop();
  return result.slice(-15);
}

function buildInitiativePrompt(state) {
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

function buildThoughtPrompt(text, image, history, lastThought) {
  const src = Array.isArray(history) ? history : [];
  const hist = src.slice(-5).map(function (m) {
    const role = m && m.role === 'user' ? 'Он: ' : 'Ты: ';
    const content = m && typeof m.content === 'string' ? m.content : '';
    return role + content;
  }).join('\n');

  return 'Ты Маша. Контекст:\n' + hist +
    '\nПользователь написал: ' + (text || (image ? '[фото]' : '[пусто]')) +
    '\nТвоя прошлая мысль: ' + (lastThought || 'ничего') +
    '\nНапиши ОДНУ мысль до 15 слов про себя, lowercase, не для пользователя.';
}

function buildUserContent(text, image) {
  if (image) {
    return [
      { type: 'text', text: text || 'Отреагируй на это фото.' },
      { type: 'image_url', image_url: { url: image } }
    ];
  }
  return text || '';
}

function buildSystemMessage(systemPrompt, thought) {
  return {
    role: 'system',
    content: String(systemPrompt || '') + '\n\nТы сейчас думаешь: ' + (thought || 'ничего особого')
  };
}

function parseInitiative(reply) {
  const r = String(reply || '').trim();
  if (r.indexOf('ХОЧУ:') === 0) return { initiative: true, text: r.slice('ХОЧУ:'.length).trim() };
  if (r.indexOf('НЕ ХОЧУ:') === 0) return { initiative: false, reason: r.slice('НЕ ХОЧУ:'.length).trim() };
  return null;
}

/* ------------------------------------------------------------- core handler */

async function processRequest(body, cfg) {
  const conf = cfg || getConfig({});
  const reqBody = body && typeof body === 'object' ? body : {};
  const text = reqBody.text;
  const image = reqBody.image;
  const systemPrompt = reqBody.systemPrompt;
  const history = reqBody.history;
  const lastThought = reqBody.lastThought;

  /* === ИНИЦИАТИВА === */
  if (reqBody.checkInitiative) {
    const out = await askDeepSeek([{ role: 'user', content: buildInitiativePrompt(reqBody.state) }], conf.textModel, conf);

    if (!out.ok) {
      const e = errorFromFailure(out);
      return { status: 200, data: Object.assign({ ok: false, initiative: false, text: '', reply: SOFT_REPLY }, e) };
    }

    const parsed = parseInitiative(out.reply);
    const result = parsed || { initiative: false, reason: String(out.reply).slice(0, 200) };
    return { status: 200, data: Object.assign({ ok: true }, result) };
  }

  /* === ВНУТРЕННИЙ МОНОЛОГ === */
  let thought = '';
  if (conf.thoughts && (text || image)) {
    const out = await askDeepSeek(
      [{ role: 'user', content: buildThoughtPrompt(text, image, history, lastThought) }],
      conf.textModel, conf
    );
    if (out.ok) thought = String(out.reply).slice(0, 120).trim();
  }

  /* === ЧАТ: с историей, при неудаче — без истории === */
  const cleanHistory = sanitizeHistory(history);
  const userContent = buildUserContent(text, image);
  const model = image ? conf.visionModel : conf.textModel;
  const systemMsg = buildSystemMessage(systemPrompt, thought);
  const fullMessages = [systemMsg].concat(cleanHistory, [{ role: 'user', content: userContent }]);

  let out = await askDeepSeek(fullMessages, model, conf);
  if (!out.ok && cleanHistory.length) {
    console.error('[worker] retry without history, reason:', out.kind, out.status || '');
    out = await askDeepSeek([systemMsg, { role: 'user', content: userContent }], model, conf);
  }

  if (!out.ok) {
    const e = errorFromFailure(out);
    return { status: 200, data: Object.assign({ ok: false, thought: thought, reply: SOFT_REPLY }, e) };
  }

  return { status: 200, data: { ok: true, reply: String(out.reply), thought: thought } };
}

function diagnostics(cfg) {
  const conf = cfg || getConfig({});
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    host: 'cloudflare-worker',
    hasKey: conf.hasKey,
    models: { text: conf.textModel, vision: conf.visionModel },
    timeoutMs: conf.timeoutMs,
    thoughts: conf.thoughts,
    time: new Date().toISOString(),
    hint: conf.hasKey
      ? 'воркер жив, ключ на месте. отправь POST с {text, history, systemPrompt}'
      : 'воркер жив, но нет секрета DEEPSEEK_API_KEY — wrangler secret put DEEPSEEK_API_KEY'
  };
}

/* -------------------------------------------------------------------- entry */

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env || {});
    let method = 'GET';
    try {
      method = String(request.method || 'GET').toUpperCase();
    } catch (e) {
      method = 'GET';
    }

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === 'GET' || method === 'HEAD') {
      // Любой GET — диагностика: открыл адрес в браузере и видно, что релей жив.
      return json(200, diagnostics(cfg));
    }

    if (method !== 'POST') {
      return json(405, softError('method_not_allowed', 'поддерживаются только GET, POST и OPTIONS'));
    }

    const parsed = await parseRequestBody(request);
    if (!parsed.ok) {
      return json(400, softError(parsed.code, parsed.detail || 'некорректный JSON в теле запроса'));
    }

    if (!cfg.hasKey) {
      return json(500, softError('no_api_key', 'в воркере не настроен секрет DEEPSEEK_API_KEY'));
    }

    try {
      const result = await processRequest(parsed.body, cfg);
      return json(result.status, result.data);
    } catch (e) {
      console.error('[worker] unhandled error:', e);
      return json(500, softError('server_error', 'внутренняя ошибка релея'));
    }
  }
};
