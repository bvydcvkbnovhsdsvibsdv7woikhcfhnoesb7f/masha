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
    // Распознавание речи (голосовые). Порядок: Workers AI → Groq → OpenAI → Hugging Face.
    ai: e.AI || null,
    groqKey: e.GROQ_API_KEY || '',
    openaiKey: e.OPENAI_API_KEY || '',
    hfToken: e.HF_TOKEN || '',
    // озвучка её голосом: локальный XTTS / ElevenLabs / Fish / OpenAI
    localTtsUrl: e.LOCAL_TTS_URL || '',
    elevenKey: e.ELEVENLABS_KEY || '',
    elevenVoice: e.ELEVENLABS_VOICE_ID || '',
    fishKey: e.FISH_KEY || '',
    fishVoice: e.FISH_VOICE_ID || '',
    // бесплатная облачная озвучка через публичное HF-пространство (XTTS v2)
    hfTtsSpace: e.HF_TTS_SPACE || '',
    hfTtsRefUrl: e.HF_TTS_REF_URL || 'https://bvydcvkbnovhsdsvibsdv7woikhcfhnoesb7f.github.io/masha/voice/ref.wav',
    hfTtsLang: e.HF_TTS_LANG || 'ru',
    baseUrl: e.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions',
    thoughts: String(e.DEEPSEEK_THOUGHTS === undefined ? '1' : e.DEEPSEEK_THOUGHTS) !== '0',
    timeoutMs: num(e.RELAY_TIMEOUT_MS, 30000),
    maxTokens: num(e.RELAY_MAX_TOKENS, 700),
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
async function askDeepSeek(messages, model, cfg, depth) {
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
      // У deepseek-flash часть токенов уходит на внутреннее рассуждение
      // (reasoning_tokens), и при малом лимите на сам ответ может не остаться.
      // Поэтому при пустом ответе пробуем ещё раз с удвоенным лимитом.
      const reason = data && data.choices && data.choices[0] ? data.choices[0].finish_reason : '';
      const used = data && data.usage && data.usage.completion_tokens_details
        ? data.usage.completion_tokens_details.reasoning_tokens : 0;
      if (cfg.maxTokens < 2000 && (depth || 0) < 2) {
        console.error('[relay] пустой ответ (finish=' + reason + ', reasoning=' + used + ') — повтор с лимитом ' + (cfg.maxTokens * 2));
        return askDeepSeek(messages, model, Object.assign({}, cfg, { maxTokens: cfg.maxTokens * 2 }), (depth || 0) + 1);
      }
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
    stt: sttProvider(cfg) || 'не настроено (Workers AI binding AI, или GROQ_API_KEY / OPENAI_API_KEY / HF_TOKEN)',
    tts: ttsProvider(cfg) || 'не настроено (LOCAL_TTS_URL / ELEVENLABS_KEY+VOICE_ID / FISH_KEY+VOICE_ID / OPENAI_API_KEY)',
    timeoutMs: cfg.timeoutMs,
    thoughts: cfg.thoughts,
    time: new Date().toISOString(),
    hint: cfg.key
      ? 'релей жив, ключ на месте. отправь POST с {text, history, systemPrompt}'
      : 'релей жив, но не задан секрет DEEPSEEK_API_KEY (Settings → Variables and Secrets)'
  };
}

/* Название трека по ссылке: сервер открывает страницу и достаёт og:title.
   Нужно, чтобы Маша понимала, какую музыку ей скинули (в браузере так нельзя — CORS). */
async function handleMeta(body, cfg) {
  const raw = typeof body.meta === 'string' ? body.meta.trim() : '';
  let target;
  try { target = new URL(raw); } catch (e) {
    return { status: 400, data: softError('bad_url', 'нужна ссылка http(s)://…') };
  }
  if (!/^https?:$/i.test(target.protocol)) {
    return { status: 400, data: softError('bad_url', 'поддерживаются только http и https') };
  }
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(target.hostname)) {
    return { status: 400, data: softError('bad_url', 'внутренние адреса не открываю') };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(target.href, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MashaRelay/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const html = (await res.text()).slice(0, 400000);
    const pick = (rx) => { const m = rx.exec(html); return m ? decodeEntities(m[1]).trim() : ''; };
    const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
      || pick(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const description = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const image = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    return {
      status: 200,
      data: { ok: true, url: target.href, title: title.slice(0, 200), description: description.slice(0, 300), image: image.slice(0, 500) }
    };
  } catch (e) {
    return { status: 200, data: { ok: false, error: 'meta_failed', message: 'не удалось открыть ссылку: ' + ((e && e.message) || e), url: target.href } };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
}

/* Умное распознавание трека: берём что есть (теги, имя файла, ссылку) и ищем
   в бесплатной базе iTunes (без ключа) — получаем исполнителя, название, альбом,
   обложку, жанр и 30-секундный превью-фрагмент. */
function guessTrackQuery(body) {
  const parts = [];
  const push = (v) => { if (v && typeof v === 'string') parts.push(v.replace(/\s+/g, ' ').trim()); };
  push(body.artist);
  push(body.title);
  if (!parts.length && body.filename) push(body.filename.replace(/\.[a-z0-9]+$/i, ''));
  const q = parts.join(' ').replace(/[\[\](){}]/g, ' ')
    .replace(/\b(official|video|lyrics?|audio|remix|prod\.?\s*\S+|feat\.?\s*\S+|ft\.?\s*\S+|128|192|256|320|kbps|hq|hd)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return q.slice(0, 120);
}

async function handleMusic(body, cfg) {
  const q = guessTrackQuery(body);
  if (!q) return { status: 400, data: softError('empty_query', 'нужно название или файл трека') };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = 'https://itunes.apple.com/search?media=music&limit=5&country=RU&term=' + encodeURIComponent(q);
    const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    const list = (data && data.results) || [];
    if (!list.length) {
      return { status: 200, data: { ok: false, error: 'not_found', query: q, message: 'трек не нашёлся' } };
    }
    // выбираем лучшее совпадение: сравниваем слова запроса с названием/исполнителем
    const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scoreOf = (it) => {
      const hay = ((it.trackName || '') + ' ' + (it.artistName || '')).toLowerCase();
      let s = 0;
      for (const w of words) if (hay.indexOf(w) !== -1) s += 1;
      return s;
    };
    list.sort((a, b) => scoreOf(b) - scoreOf(a));
    const best = list[0];
    return {
      status: 200,
      data: {
        ok: true,
        query: q,
        artist: best.artistName || '',
        title: best.trackName || '',
        album: best.collectionName || '',
        genre: best.primaryGenreName || '',
        year: (best.releaseDate || '').slice(0, 4),
        artwork: (best.artworkUrl100 || '').replace('100x100', '300x300'),
        preview: best.previewUrl || '',
        durationSec: best.trackTimeMillis ? Math.round(best.trackTimeMillis / 1000) : 0,
        alternatives: list.slice(1, 4).map(it => ({ artist: it.artistName || '', title: it.trackName || '' }))
      }
    };
  } catch (e) {
    return { status: 200, data: { ok: false, error: 'music_failed', query: q, message: 'не удалось найти трек: ' + ((e && e.message) || e) } };
  } finally {
    clearTimeout(timer);
  }
}

/* Распознавание голосового: текст из аудио. Поддерживаем несколько движков,
   чтобы не зависеть от одного сервиса:
   1) Cloudflare Workers AI (binding AI) — бесплатно, уже внутри твоего воркера;
   2) Groq (GROQ_API_KEY) — бесплатный тариф;
   3) OpenAI (OPENAI_API_KEY);
   4) Hugging Face (HF_TOKEN) — бесплатный тариф. */
function sttProvider(cfg) {
  if (cfg.ai && typeof cfg.ai.run === 'function') return 'cloudflare';
  if (cfg.groqKey) return 'groq';
  if (cfg.openaiKey) return 'openai';
  if (cfg.hfToken) return 'huggingface';
  return '';
}

async function handleStt(body, cfg) {
  const audio = typeof body.audio === 'string' ? body.audio : '';
  if (!audio) return { status: 400, data: softError('no_audio', 'нет аудио для распознавания') };
  const mime = body.mime || 'audio/ogg';
  const provider = sttProvider(cfg);
  if (!provider) {
    return {
      status: 200,
      data: {
        ok: false, error: 'no_stt_key', stt: false,
        message: 'распознавание голосовых не настроено. Проще всего: Cloudflare → Workers → твой воркер → Settings → Bindings → Add → Workers AI → имя AI. Или добавь секрет GROQ_API_KEY / HF_TOKEN.'
      }
    };
  }
  let buf;
  try {
    buf = base64ToArrayBuffer(audio);
  } catch (e) {
    return { status: 400, data: softError('bad_audio', 'аудио не декодируется') };
  }
  const started = Date.now();
  try {
    if (provider === 'cloudflare') {
      // Workers AI: Whisper принимает массив байтов
      const bytes = new Uint8Array(buf);
      try {
        const out = await cfg.ai.run('@cf/openai/whisper-large-v3-turbo', { audio: Array.from(bytes) });
        const text = String((out && (out.text || (out.result && out.result.text))) || '').trim();
        return { status: 200, data: { ok: !!text, stt: true, provider: provider, text: text, ms: Date.now() - started, message: text ? '' : 'речь не распознана' } };
      } catch (e1) {
        // Запасной вариант: тот же whisper без суффикса turbo
        try {
          const out2 = await cfg.ai.run('@cf/openai/whisper', { audio: Array.from(bytes) });
          const text2 = String((out2 && (out2.text || (out2.result && out2.result.text))) || '').trim();
          return { status: 200, data: { ok: !!text2, stt: true, provider: provider + '-whisper', text: text2, ms: Date.now() - started, message: text2 ? '' : 'речь не распознана' } };
        } catch (e2) {
          return { status: 200, data: { ok: false, error: 'stt_failed', stt: true, provider: provider, message: 'не удалось распознать: ' + String(e2 && e2.message || e2) + ' | turbo: ' + String(e1 && e1.message || e1) + ' | байт: ' + bytes.length } };
        }
      }
    }
    if (provider === 'huggingface') {
      const res = await fetch('https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.hfToken, 'Content-Type': mime },
        body: new Uint8Array(buf)
      });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      const text = String((data && (data.text || (Array.isArray(data) && data[0] && data[0].text))) || '').trim();
      if (!res.ok) return { status: 200, data: { ok: false, error: 'stt_' + res.status, stt: true, provider: provider, message: raw.slice(0, 200) } };
      return { status: 200, data: { ok: !!text, stt: true, provider: provider, text: text, ms: Date.now() - started, message: text ? '' : 'речь не распознана' } };
    }
    // groq / openai — одинаковый OpenAI-совместимый протокол
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), 'voice.' + (mime.split('/')[1] || 'ogg'));
    form.append('model', provider === 'groq' ? 'whisper-large-v3' : 'whisper-1');
    form.append('language', 'ru');
    form.append('response_format', 'json');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const url = provider === 'groq'
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const key = provider === 'groq' ? cfg.groqKey : cfg.openaiKey;
      const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: controller.signal });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      if (!res.ok) {
        return { status: 200, data: { ok: false, error: 'stt_' + res.status, stt: true, provider: provider, message: (data && data.error && data.error.message) || raw.slice(0, 200) } };
      }
      const text = String((data && data.text) || '').trim();
      return { status: 200, data: { ok: !!text, stt: true, provider: provider, text: text, ms: Date.now() - started, message: text ? '' : 'речь не распознана' } };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { status: 200, data: { ok: false, error: 'stt_failed', stt: true, provider: provider, message: 'не удалось распознать: ' + ((e && e.message) || e) } };
  }
}

function base64ToArrayBuffer(b64) {
  const clean = String(b64).replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* Озвучка ЛЮБОГО текста её голосом. Провайдеры по приоритету:
   1) LOCAL_TTS_URL — клонированный голос на своём ПК (XTTS v2) — бесплатно, любой текст;
   2) ELEVENLABS_KEY + ELEVENLABS_VOICE_ID — облачное клонирование;
   3) FISH_KEY + FISH_VOICE_ID — облачное клонирование;
   4) OPENAI_API_KEY — голоса OpenAI (без клонирования, но живые). */
function ttsProvider(cfg) {
  if (cfg.localTtsUrl) return 'local';
  if (cfg.elevenKey && cfg.elevenVoice) return 'elevenlabs';
  if (cfg.fishKey && cfg.fishVoice) return 'fish';
  // бесплатное облачное клонирование через публичное HF-пространство (XTTS v2)
  if (cfg.hfTtsSpace) return 'hfspace';
  if (cfg.openaiKey) return 'openai';
  return '';
}

/* ==== Озвучка через публичное HF-пространство (бесплатно, без ключей) ====
   Пространство принимает ФАЙЛ образца голоса + текст + язык, отдаёт WAV.
   Шаги: скачать образец с нашего сайта, загрузить в пространство,
   запустить синтез (gradio /call), забрать файл. */
let hfUploadedPath = '';      // кэш загруженного образца (на время жизни воркера)
const hfAudioCache = {};      // текст -> base64 (повторные фразы мгновенно)

/* "Nymbo/Voice-Clone-Multilingual" -> https://nymbo-voice-clone-multilingual.hf.space */
function hfSpaceBase(space) {
  const s = String(space || '').trim();
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return 'https://' + slug + '.hf.space';
}

async function hfUploadReference(cfg, signal) {
  if (hfUploadedPath) return hfUploadedPath;
  const refRes = await fetch(cfg.hfTtsRefUrl, { signal });
  if (!refRes.ok) throw new Error('не скачался образец голоса: ' + refRes.status);
  const refBuf = await refRes.arrayBuffer();
  const form = new FormData();
  form.append('files', new Blob([refBuf], { type: 'audio/wav' }), 'ref.wav');
  const upRes = await fetch(hfSpaceBase(cfg.hfTtsSpace) + '/gradio_api/upload?upload_id=' + Date.now(), {
    method: 'POST', body: form, signal
  });
  if (!upRes.ok) throw new Error('загрузка образца в пространство: ' + upRes.status);
  const paths = await upRes.json();
  if (!Array.isArray(paths) || !paths.length) throw new Error('пространство не вернуло путь файла');
  hfUploadedPath = paths[0];
  return hfUploadedPath;
}

async function handleHfSpaceTts(text, cfg, signal) {
  if (hfAudioCache[text]) {
    return { ok: true, tts: true, provider: 'hfspace-cache', mime: 'audio/wav', audio: hfAudioCache[text] };
  }
  const base = hfSpaceBase(cfg.hfTtsSpace);
  const refPath = await hfUploadReference(cfg, signal);
  const startRes = await fetch(base + '/gradio_api/call/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [text, { path: refPath, meta: { _type: 'gradio.FileData' } }, cfg.hfTtsLang || 'ru']
    }),
    signal
  });
  if (!startRes.ok) throw new Error('синтез не запустился: ' + startRes.status);
  const startJson = await startRes.json();
  const eventId = startJson && startJson.event_id;
  if (!eventId) throw new Error('нет event_id');
  const evRes = await fetch(base + '/gradio_api/call/predict/' + eventId, { signal });
  if (!evRes.ok) throw new Error('не дождался результата: ' + evRes.status);
  const raw = await evRes.text();
  let fileObj = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const body = t.slice(5).trim();
    if (!body || body === 'null') continue;
    try {
      const arr = JSON.parse(body);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === 'object' && (item.url || item.path)) fileObj = item;
        }
      }
    } catch (e) { /* пропускаем не-JSON */ }
  }
  if (!fileObj) throw new Error('пространство не вернуло аудио');
  const audioUrl = fileObj.url || (base + '/gradio_api/file=' + fileObj.path);
  const audioRes = await fetch(audioUrl, { signal });
  if (!audioRes.ok) throw new Error('не скачалось аудио: ' + audioRes.status);
  const buf = await audioRes.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  hfAudioCache[text] = b64;
  return { ok: true, tts: true, provider: 'hfspace', mime: 'audio/wav', audio: b64 };
}

async function handleTts(body, cfg) {
  const text = typeof body.tts === 'string' ? body.tts.trim().slice(0, 600) : '';
  if (!text) return { status: 400, data: softError('no_text', 'нужен текст для озвучки') };
  const provider = ttsProvider(cfg);
  if (!provider) {
    return {
      status: 200,
      data: {
        ok: false, error: 'no_tts', tts: false,
        message: 'озвучка её голосом не настроена: нужен LOCAL_TTS_URL (XTTS на своём ПК), или ELEVENLABS_KEY+ELEVENLABS_VOICE_ID, или FISH_KEY+FISH_VOICE_ID, или HF_TTS_SPACE'
      }
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    if (provider === 'local') {
      // локальный сервер XTTS: принимает {text, speaker_wav}, отдаёт аудио
      const res = await fetch(cfg.localTtsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, language: 'ru' }),
        signal: controller.signal
      });
      if (!res.ok) return { status: 200, data: { ok: false, error: 'tts_local_' + res.status, tts: true, provider: provider } };
      const buf = await res.arrayBuffer();
      const mime = (res.headers.get('content-type') || 'audio/wav').split(';')[0];
      return { status: 200, data: { ok: true, tts: true, provider: provider, mime: mime, audio: arrayBufferToBase64(buf) } };
    }
    if (provider === 'elevenlabs') {
      const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(cfg.elevenVoice) + '?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': cfg.elevenKey, 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text: text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } }),
        signal: controller.signal
      });
      if (!res.ok) {
        const raw = await res.text();
        return { status: 200, data: { ok: false, error: 'tts_' + res.status, tts: true, provider: provider, message: raw.slice(0, 200) } };
      }
      const buf = await res.arrayBuffer();
      return { status: 200, data: { ok: true, tts: true, provider: provider, mime: 'audio/mpeg', audio: arrayBufferToBase64(buf) } };
    }
    if (provider === 'hfspace') {
      // бесплатное облачное клонирование: публичное HF-пространство XTTS v2
      const ctrlHf = new AbortController();
      const timerHf = setTimeout(() => ctrlHf.abort(), 120000);
      try {
        const out = await handleHfSpaceTts(text, cfg, ctrlHf.signal);
        return { status: 200, data: out };
      } catch (e) {
        return { status: 200, data: { ok: false, error: 'tts_hfspace', tts: true, provider: provider, message: String((e && e.message) || e) } };
      } finally {
        clearTimeout(timerHf);
      }
    }
    if (provider === 'fish') {
      const res = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.fishKey, model: 's2-pro' },
        body: JSON.stringify({ text: text, reference_id: cfg.fishVoice, format: 'mp3', mp3_bitrate: 128 }),
        signal: controller.signal
      });
      if (!res.ok) {
        const raw = await res.text();
        return { status: 200, data: { ok: false, error: 'tts_' + res.status, tts: true, provider: provider, message: raw.slice(0, 200) } };
      }
      const buf = await res.arrayBuffer();
      return { status: 200, data: { ok: true, tts: true, provider: provider, mime: 'audio/mpeg', audio: arrayBufferToBase64(buf) } };
    }
    // OpenAI TTS
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.openaiKey },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'nova', input: text, response_format: 'mp3' }),
      signal: controller.signal
    });
    if (!res.ok) {
      const raw = await res.text();
      return { status: 200, data: { ok: false, error: 'tts_' + res.status, tts: true, provider: provider, message: raw.slice(0, 200) } };
    }
    const buf = await res.arrayBuffer();
    return { status: 200, data: { ok: true, tts: true, provider: provider, mime: 'audio/mpeg', audio: arrayBufferToBase64(buf) } };
  } catch (e) {
    return { status: 200, data: { ok: false, error: 'tts_failed', tts: true, provider: provider, message: 'не удалось озвучить: ' + ((e && e.message) || e) } };
  } finally {
    clearTimeout(timer);
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function processRequest(body, cfg) {
  // Проверка «жив ли релей» через POST. Нужна там, где по этому адресу отдаётся
  // ещё и сайт (Cloudflare Workers + статика): GET перехватывает страница-заглушка,
  // а POST всегда доходит до кода.
  if (body && body.health) {
    return { status: 200, data: diagnostics(cfg, 'post-health') };
  }
  if (body && body.meta) return handleMeta(body, cfg);
  if (body && body.music) return handleMusic(body, cfg);
  if (body && body.stt) return handleStt(body, cfg);
  if (body && body.tts) return handleTts(body, cfg);
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

    // Разбор ссылки, трека и распознавание речи не требуют ключа DeepSeek —
    // работают и без него (распознавание речи берёт свой ключ GROQ/OPENAI).
    if (parsed.body && (parsed.body.meta || parsed.body.music || parsed.body.stt || parsed.body.tts)) {
      const extra = await processRequest(parsed.body, cfg);
      return json(extra.status, extra.data);
    }

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
