/**
 * masha-relay — релей к DeepSeek для приложения «Маша».
 *
 * Контракт: ВСЕГДА валидный JSON, никогда HTML и никогда стектрейс.
 *
 *   GET  /  |  GET /health  -> 200 {ok:true, service, version, hasKey, models, hint}
 *   POST /  (и любой путь)  -> 200 {ok:true, reply, thought}
 *                           -> 200 {ok:true, initiative:true, text} | {ok:true, initiative:false, reason}
 *                           -> 200 {ok:false, error, message, reply}   (мягкая ошибка)
 *                           -> 400 {ok:false, error:'bad_json', ...}
 *                           -> 500 {ok:false, error:'no_api_key', ...}
 *   OPTIONS (любой путь)    -> 204 + CORS
 *
 * Настройки (секреты/переменные окружения):
 *   DEEPSEEK_API_KEY      — обязательно (или алиас DEEPSEEK_KEY)
 *   DEEPSEEK_TEXT_MODEL   — по умолчанию deepseek-flash (доступны deepseek-chat, deepseek-reasoner, deepseek-v4-pro)
 *   DEEPSEEK_VISION_MODEL — по умолчанию deepseek-flash (модели deepseek-v4.1-flash в API НЕТ)
 *   DEEPSEEK_BASE_URL     — по умолчанию https://api.deepseek.com/chat/completions
 *   DEEPSEEK_THOUGHTS     — 0, чтобы отключить внутренний монолог (быстрее)
 *   RELAY_TIMEOUT_MS      — по умолчанию 30000
 *
 * Локально:  $env:DEEPSEEK_API_KEY="..."; node worker/local-relay.mjs
 * Cloudflare: вставить этот файл в дашборде (Edit code) → Deploy → Settings → Variables.
 */

const VERSION = '2.0.0';
const SERVICE = 'masha-relay';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400'
};

/* Мягкая фраза Маши: в её стиле, lowercase, без эмодзи. */
const SOFT_REPLY = 'блин, у меня чето связь пропала, давай еще раз?';

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
  });
}

function softError(code, message, status) {
  return {
    ok: false,
    error: code,
    message: message || 'что-то сломалось на сервере',
    reply: SOFT_REPLY
  };
}

function num(v, def) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : def;
}

function configFrom(env) {
  const e = env || {};
  return {
    key: e.DEEPSEEK_API_KEY || e.DEEPSEEK_KEY || '',
    textModel: e.DEEPSEEK_TEXT_MODEL || 'deepseek-flash',
    // deepseek-v4.1-flash в API НЕ существует (проверено запросом: поддерживаются
    // deepseek-flash и deepseek-v4-pro), поэтому для фото тоже используем flash.
    visionModel: e.DEEPSEEK_VISION_MODEL || 'deepseek-flash',
    baseUrl: e.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions',
    thoughts: String(e.DEEPSEEK_THOUGHTS === undefined ? '1' : e.DEEPSEEK_THOUGHTS) !== '0',
    timeoutMs: num(e.RELAY_TIMEOUT_MS, 30000),
    maxTokens: num(e.RELAY_MAX_TOKENS, 350),
    temperature: 0.9
  };
}

async function parseRequestBody(request) {
  let text = '';
  try {
    text = await request.text();
  } catch (e) {
    return { ok: false, code: 'bad_json', detail: 'не удалось прочитать тело запроса' };
  }
  if (!text || !text.trim()) return { ok: false, code: 'bad_json', detail: 'пустое тело запроса' };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'bad_json', detail: 'ожидался объект JSON' };
    return { ok: true, body: parsed };
  } catch (e) {
    return { ok: false, code: 'bad_json', detail: 'некорректный JSON в теле запроса' };
  }
}

/* Запрос к DeepSeek. Никогда не бросает: возвращает {ok:false, code} вместо исключения. */
async function askDeepSeek(messages, model, cfg) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => { try { controller.abort(); } catch (e) { /* ignore */ } }, cfg.timeoutMs);
  }
  try {
    const res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.key
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        stream: false
      }),
      signal: controller ? controller.signal : undefined
    });

    const raw = await res.text();
    if (!res.ok) {
      console.error('[relay] deepseek error:', res.status, raw.slice(0, 300));
      return { ok: false, code: 'deepseek_' + res.status, status: res.status, detail: raw.slice(0, 200) };
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error('[relay] deepseek returned non-json body');
      return { ok: false, code: 'deepseek_bad_response', detail: raw.slice(0, 200) };
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!content || !String(content).trim()) {
      return { ok: false, code: 'deepseek_empty', detail: JSON.stringify(data).slice(0, 200) };
    }
    return { ok: true, reply: String(content).trim() };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 20);
    console.error('[relay] deepseek fetch failed:', aborted ? 'timeout' : err && err.message);
    return { ok: false, code: aborted ? 'deepseek_timeout' : 'deepseek_unreachable', detail: String(err && err.message || err).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* История: только user/assistant, без пустых, подряд идущие одинаковые роли склеиваем. */
function sanitizeHistory(history) {
  const clean = [];
  for (const m of history || []) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    let role = m.role === 'bot' ? 'assistant' : m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const prev = clean[clean.length - 1];
    if (prev && prev.role === role) prev.content += '\n' + m.content;
    else clean.push({ role: role, content: m.content });
  }
  while (clean.length && clean[clean.length - 1].role === 'user') clean.pop();
  return clean.slice(-15);
}

async function handleInitiative(body, cfg) {
  const st = body.state || {};
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' });
  const sinceLastUser = st.lastUserMessageTime ? Math.round((Date.now() - st.lastUserMessageTime) / 60000) : 999;
  const lastMsg = (st.messages || []).slice(-1)[0];
  const prompt =
    'Ты Маша, 16 лет, Красноярск, ты девушка Эдуарда. Сейчас: ' + now + '.\n' +
    'Твоё состояние: ' + (st.currentState || 'calm') + '. Отношения: ' + (st.relationship || 80) + '/100.\n' +
    'Он не писал: ' + sinceLastUser + ' мин. Он сейчас: ' + (st.userStatus || 'awake') + '.\n' +
    'Последнее обсуждали: ' + String((lastMsg && lastMsg.content) || 'ничего').slice(0, 100) + '.\n' +
    'Твоя прошлая мысль: ' + String(st.lastThought || 'ничего').slice(0, 100) + '.\n\n' +
    'Хочешь написать ему прямо сейчас? Пиши коротко, 1-3 слова, как в переписке: без точки в конце, без эмодзи.\n' +
    'Формат ответа ТОЛЬКО: "ХОЧУ: <текст>" или "НЕ ХОЧУ: <почему>".';

  const out = await askDeepSeek([{ role: 'user', content: prompt }], cfg.textModel, cfg);
  if (!out.ok) {
    return { status: 200, data: Object.assign({ ok: false, initiative: false }, softError(out.code, 'не смогла придумать сообщение')) };
  }
  const line = out.reply.trim();
  if (/^ХОЧУ\s*:/i.test(line)) {
    return { status: 200, data: { ok: true, initiative: true, text: line.replace(/^ХОЧУ\s*:/i, '').trim() } };
  }
  if (/^НЕ\s*ХОЧУ\s*:/i.test(line)) {
    return { status: 200, data: { ok: true, initiative: false, reason: line.replace(/^НЕ\s*ХОЧУ\s*:/i, '').trim() } };
  }
  // модель ответила не по формату — считаем, что не хочет
  return { status: 200, data: { ok: true, initiative: false, reason: line.slice(0, 120) } };
}

async function handleChat(body, cfg) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const image = typeof body.image === 'string' && body.image ? body.image : '';
  if (!text && !image) {
    return { status: 400, data: softError('empty_message', 'в запросе нет ни текста, ни фото') };
  }

  const history = sanitizeHistory(body.history);

  /* Внутренний монолог: одна короткая мысль, чтобы ответ был со своим подтекстом. */
  let thought = '';
  if (cfg.thoughts) {
    const hist = history.slice(-5).map(m => (m.role === 'user' ? 'Он: ' : 'Ты: ') + m.content).join('\n');
    const tp = 'Ты Маша, девушка Эдуарда. Контекст:\n' + (hist || 'нет') +
      '\nОн написал: ' + (text || '[фото]') +
      '\nТвоя прошлая мысль: ' + String(body.lastThought || 'ничего').slice(0, 80) +
      '\nНапиши ОДНУ мысль до 15 слов про себя, lowercase, не для него.';
    const outThought = await askDeepSeek([{ role: 'user', content: tp }], cfg.textModel, cfg);
    if (outThought.ok) thought = outThought.reply.slice(0, 120);
  }

  let userContent;
  if (image) {
    userContent = [
      { type: 'text', text: text || 'Отреагируй на это фото.' },
      { type: 'image_url', image_url: { url: image } }
    ];
  } else {
    userContent = text;
  }

  const systemMsg = {
    role: 'system',
    content: String(body.systemPrompt || 'Ты Маша, девушка Эдуарда.') +
      '\n\nТы сейчас думаешь: ' + (thought || 'ничего особого')
  };

  const model = image ? cfg.visionModel : cfg.textModel;
  let out = await askDeepSeek([systemMsg].concat(history, [{ role: 'user', content: userContent }]), model, cfg);
  if (!out.ok && history.length) {
    console.error('[relay] retry without history, reason:', out.code);
    out = await askDeepSeek([systemMsg, { role: 'user', content: userContent }], model, cfg);
  }
  if (!out.ok) {
    return { status: 200, data: Object.assign({ reply: SOFT_REPLY, thought: thought }, softError(out.code, 'AI не ответил')) };
  }
  return { status: 200, data: { ok: true, reply: out.reply, thought: thought, model: model } };
}

function diagnostics(cfg, host) {
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    host: host || 'cloudflare-worker',
    hasKey: !!cfg.key,
    models: { text: cfg.textModel, vision: cfg.visionModel },
    timeoutMs: cfg.timeoutMs,
    thoughts: cfg.thoughts,
    time: new Date().toISOString(),
    hint: cfg.key
      ? 'релей жив, ключ на месте. отправь POST с {text, history, systemPrompt}'
      : 'релей жив, но не задан секрет DEEPSEEK_API_KEY (Settings → Variables and Secrets)'
  };
}

async function processRequest(body, cfg) {
  // Проверка «жив ли релей» через POST. Нужна там, где по этому адресу отдаётся
  // ещё и сайт (Cloudflare Workers + статика): GET перехватывает страница-заглушка,
  // а POST всегда доходит до кода.
  if (body && body.health) {
    return { status: 200, data: diagnostics(cfg, 'post-health') };
  }
  if (body && body.checkInitiative) return handleInitiative(body, cfg);
  return handleChat(body, cfg);
}

export default {
  async fetch(request, env, ctx) {
    const cfg = configFrom(env);
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (method === 'GET') {
      return json(200, diagnostics(cfg, 'cloudflare-worker'));
    }

    if (method !== 'POST') {
      return json(405, softError('method_not_allowed', 'поддерживаются только GET, POST и OPTIONS'));
    }

    const parsed = await parseRequestBody(request);
    if (!parsed.ok) return json(400, softError(parsed.code, parsed.detail));

    if (!cfg.key) {
      return json(500, softError('no_api_key', 'в воркере не настроен секрет DEEPSEEK_API_KEY'));
    }

    try {
      const result = await processRequest(parsed.body, cfg);
      return json(result.status, result.data);
    } catch (e) {
      console.error('[relay] unhandled error:', e);
      return json(500, softError('server_error', 'внутренняя ошибка релея'));
    }
  }
};

/* Экспорт для тестов и адаптеров (Deno/Netlify/Vercel используют тот же код). */
export { processRequest, configFrom, askDeepSeek, softError, VERSION, SERVICE };
