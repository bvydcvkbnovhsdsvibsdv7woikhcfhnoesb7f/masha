/**
 * masha-fixed / test/relay.test.mjs
 * Тесты релея (Vercel api/relay.js + Cloudflare worker/worker.js).
 *
 * Главная проверка: при ЛЮБОМ сценарии наружу уходит валидный JSON,
 * а не HTML и не пустое тело.
 *
 * Запуск:
 *   & "C:\Users\Эдуард\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const relay = require('../api/relay.js');
const worker = require('../worker/worker.js');

const handler = relay.default;
const workerFetch = worker.default.fetch;

const SOFT = 'блин, у меня чето связь пропала, давай еще раз?';

/* --------------------------------------------------------------- test utils */

/** Подменяет globalThis.fetch последовательностью ответов. Возвращает журнал вызовов. */
const realFetch = globalThis.fetch;

function installFetch(responses) {
  const queue = responses.slice();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (!queue.length) throw new Error('fetch mock: неожиданный лишний вызов');
    const item = queue.shift();
    if (typeof item === 'function') return item(url, init);
    if (item instanceof Error) throw item;
    return item;
  };
  return calls;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function deepseekReply(content) {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content } }] });
}

function htmlResponse(status = 200) {
  return new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' }
  });
}

/** Мок Vercel res: копит код и тело, ловит повторную установку заголовков. */
function makeRes() {
  const state = { status: null, body: null, headers: {}, headersAfterStatus: 0, setHeaderCalls: 0, ended: false };
  const res = {
    setHeader(k, v) {
      if (state.status !== null) state.headersAfterStatus++;
      state.setHeaderCalls++;
      state.headers[k.toLowerCase()] = v;
    },
    status(code) {
      state.status = code;
      return {
        json(obj) { state.body = obj; return res; },
        send(payload) { state.body = payload; return res; },
        end(payload) { if (payload !== undefined) state.body = payload; state.ended = true; return res; }
      };
    },
    end(payload) { if (payload !== undefined) state.body = payload; state.ended = true; return res; },
    writeHead(code, headers) {
      state.status = code;
      Object.assign(state.headers, headers || {});
    }
  };
  return { res, state };
}

async function callRelay(req) {
  const { res, state } = makeRes();
  await handler(req, res);
  return state;
}

/** Проверка «ответ действительно JSON, а не HTML». */
function assertJsonResponse(state, { status } = {}) {
  if (status !== undefined) assert.equal(state.status, status, 'HTTP статус');
  assert.match(
    String(state.headers['content-type'] || ''),
    /^application\/json/,
    'Content-Type должен быть application/json'
  );
  assert.ok(state.body !== null && state.body !== undefined, 'тело ответа не должно быть пустым');
  const text = typeof state.body === 'string' ? state.body : JSON.stringify(state.body);
  assert.ok(!/^\s*</.test(text), 'тело ответа не должно быть HTML');
  // Тело, которое реально уйдёт по сети, обязано быть разбираемым JSON.
  // (для res.status().json() это уже объект, поэтому проверяем через сериализацию)
  const asText = typeof state.body === 'string' ? state.body : null;
  if (asText !== null) {
    let parsed = null;
    assert.doesNotThrow(() => { parsed = JSON.parse(asText); }, 'тело должно быть валидным JSON');
    assert.equal(typeof parsed, 'object');
  }
  assert.equal(state.headersAfterStatus, 0, 'заголовки нельзя ставить после отправки статуса');
  return state.body;
}

/* ----------------------------------------------------------------- константы */

test('экспортирует мягкую фразу Маши в lowercase без эмодзи', () => {
  assert.equal(relay.SOFT_REPLY, SOFT);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(relay.SOFT_REPLY), 'без эмодзи');
  assert.equal(relay.SOFT_REPLY, relay.SOFT_REPLY.toLowerCase());
  assert.equal(relay.SERVICE, 'masha-relay');
  assert.equal(typeof relay.VERSION, 'string');
});

/* ------------------------------------------------------------------ api/relay */

test('GET /api/relay — диагностика: валидный JSON, видно что релей жив', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    const state = await callRelay({ method: 'GET', headers: {}, body: undefined });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(body.service, 'masha-relay');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.hasKey, true);
    assert.equal(state.headers['access-control-allow-origin'], '*');
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('GET /api/relay без ключа — hasKey:false, но всё равно 200 JSON', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const state = await callRelay({ method: 'GET', headers: {} });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(body.hasKey, false);
  } finally {
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('OPTIONS /api/relay -> 204 с CORS', async () => {
  const state = await callRelay({ method: 'OPTIONS', headers: {} });
  assert.equal(state.status, 204);
  assert.equal(state.headers['access-control-allow-origin'], '*');
  assert.match(String(state.headers['access-control-allow-methods']), /POST/);
});

test('PUT /api/relay -> 405 JSON, не HTML', async () => {
  const state = await callRelay({ method: 'PUT', headers: {}, body: {} });
  const body = assertJsonResponse(state, { status: 405 });
  assert.equal(body.ok, false);
  assert.equal(body.error, 'method_not_allowed');
  assert.equal(body.reply, SOFT);
});

test('нет ключа -> 500 JSON {ok:false, error:no_api_key, message, reply}', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevAlias = process.env.DEEPSEEK_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_KEY;
  try {
    const state = await callRelay({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'привет' })
    });
    const body = assertJsonResponse(state, { status: 500 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'no_api_key');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message.length > 3, 'сообщение по-русски');
    assert.equal(body.reply, SOFT);
  } finally {
    if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevAlias !== undefined) process.env.DEEPSEEK_KEY = prevAlias;
  }
});

test('DEEPSEEK_KEY работает как алиас DEEPSEEK_API_KEY', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevAlias = process.env.DEEPSEEK_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_KEY = 'alias-key';
  const calls = installFetch([deepseekReply('мысль'), deepseekReply('привет, я тут')]);
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(calls.length, 2);
    assert.match(String(calls[0].init.headers.Authorization), /^Bearer alias-key$/);
  } finally {
    restoreFetch();
    if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevAlias === undefined) delete process.env.DEEPSEEK_KEY; else process.env.DEEPSEEK_KEY = prevAlias;
  }
});

test('невалидный JSON body -> 400 JSON bad_json (без HTML)', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  installFetch([]);
  try {
    const state = await callRelay({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text": "привет",,}'
    });
    const body = assertJsonResponse(state, { status: 400 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'bad_json');
    assert.equal(body.reply, SOFT);
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('req.body уже объект и req.body — строка: оба случая работают', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    // объект (Vercel часто парсит сам)
    let calls = installFetch([deepseekReply('думаю'), deepseekReply('ага')]);
    let state = await callRelay({ method: 'POST', body: { text: 'как ты?' } });
    let body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(calls.length, 2);
    restoreFetch();

    // строка
    calls = installFetch([deepseekReply('думаю'), deepseekReply('нормально')]);
    state = await callRelay({ method: 'POST', body: JSON.stringify({ text: 'как ты?' }) });
    body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.reply, 'нормально');
    assert.equal(calls.length, 2);
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('обычный чат -> 200 {ok:true, reply, thought}, история санитизирована', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const calls = installFetch([deepseekReply('скучно без тебя'), deepseekReply('привет) я тут')]);
  try {
    const state = await callRelay({
      method: 'POST',
      body: {
        text: 'привет',
        systemPrompt: 'Ты Маша',
        history: [
          { role: 'user', content: 'ты тут?' },
          { role: 'user', content: '' },
          { role: 'assistant', content: 'тут' },
          { role: 'user', content: 'ага' }
        ]
      }
    });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(body.reply, 'привет) я тут');
    assert.equal(body.thought, 'скучно без тебя');
    assert.equal(calls.length, 2, 'два запроса: монолог + чат');

    const sent = JSON.parse(calls[1].init.body);
    assert.equal(sent.model, 'deepseek-flash');
    assert.equal(sent.stream, false);
    assert.equal(sent.messages[0].role, 'system');
    assert.match(sent.messages[0].content, /Ты Маша/);
    assert.equal(sent.messages[sent.messages.length - 1].content, 'привет');
    // последняя запись истории перед новым сообщением — assistant (user-хвост срезан)
    assert.equal(sent.messages[sent.messages.length - 2].role, 'assistant');
    const roles = sent.messages.map((m) => m.role);
    for (let i = 2; i < roles.length; i++) {
      assert.ok(!(roles[i] === 'user' && roles[i - 1] === 'user'), 'подряд идущие user недопустимы');
    }
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('картинка -> vision-модель и content-массив', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevVision = process.env.DEEPSEEK_VISION_MODEL;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  delete process.env.DEEPSEEK_VISION_MODEL;
  const calls = installFetch([deepseekReply('что это там'), deepseekReply('о, котик')]);
  try {
    const state = await callRelay({
      method: 'POST',
      body: { text: 'смотри', image: 'data:image/png;base64,AAA', history: [] }
    });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.reply, 'о, котик');
    const sent = JSON.parse(calls[1].init.body);
    assert.equal(sent.model, 'deepseek-v4.1-flash');
    const last = sent.messages[sent.messages.length - 1].content;
    assert.ok(Array.isArray(last));
    assert.equal(last[1].image_url.url, 'data:image/png;base64,AAA');
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevVision === undefined) delete process.env.DEEPSEEK_VISION_MODEL; else process.env.DEEPSEEK_VISION_MODEL = prevVision;
  }
});

test('DeepSeek отдаёт 500 -> ретрай без истории -> JSON-ошибка deepseek_500 с мягким reply', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const calls = installFetch([
    deepseekReply('думаю о нем'),
    jsonResponse({ error: 'boom' }, 500),
    jsonResponse({ error: 'boom again' }, 500)
  ]);
  try {
    const state = await callRelay({
      method: 'POST',
      body: {
        text: 'привет',
        history: [
          { role: 'assistant', content: 'ага' },
          { role: 'user', content: 'ок' }
        ]
      }
    });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_500');
    assert.equal(typeof body.message, 'string');
    assert.equal(body.reply, SOFT);

    assert.equal(calls.length, 3, 'монолог + попытка с историей + ретрай без истории');
    const withHistory = JSON.parse(calls[1].init.body);
    const withoutHistory = JSON.parse(calls[2].init.body);
    assert.ok(withHistory.messages.length > withoutHistory.messages.length, 'ретрай короче');
    assert.equal(withoutHistory.messages.length, 2);
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('DeepSeek 500 при непустой истории -> ровно один ретрай без истории', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const calls = installFetch([
    deepseekReply('думаю'),
    jsonResponse({ error: 'bad' }, 500),
    jsonResponse({ error: 'bad again' }, 503)
  ]);
  try {
    const state = await callRelay({
      method: 'POST',
      body: {
        text: 'привет',
        history: [
          { role: 'assistant', content: 'тут' },
          { role: 'user', content: 'ок' }
        ]
      }
    });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_503', 'код — от последней попытки');
    assert.equal(body.reply, SOFT);
    assert.equal(body.thought, 'думаю', 'мысль сохраняем');
    assert.equal(calls.length, 3, 'монолог + с историей + ретрай без истории');

    const retrySent = JSON.parse(calls[2].init.body);
    assert.equal(retrySent.messages.length, 2, 'ретрай: только system + user');
    assert.equal(retrySent.messages[0].role, 'system');
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('DeepSeek отдаёт HTML -> JSON-ошибка deepseek_bad_response, приложение не падает', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  installFetch([
    deepseekReply('думаю'),
    htmlResponse(200)
  ]);
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_bad_response');
    assert.equal(body.reply, SOFT);
    assert.ok(!JSON.stringify(body).includes('<!DOCTYPE'), 'никакого HTML в ответе');
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('DeepSeek отдаёт HTML при 502 -> deepseek_502', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  installFetch([
    deepseekReply('думаю'),
    htmlResponse(502)
  ]);
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.error, 'deepseek_502');
    assert.equal(body.reply, SOFT);
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('сеть упала (fetch throw) -> JSON deepseek_unreachable, без стектрейса наружу', async () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  installFetch([
    deepseekReply('думаю'),
    new Error('ECONNRESET')
  ]);
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_unreachable');
    assert.equal(body.reply, SOFT);
    assert.ok(!JSON.stringify(body).includes('ECONNRESET'), 'детали ошибки наружу не отдаём');
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('DeepSeek молчит -> срабатывает таймаут RELAY_TIMEOUT_MS -> deepseek_timeout', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevTimeout = process.env.RELAY_TIMEOUT_MS;
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.RELAY_TIMEOUT_MS = '20';
  process.env.DEEPSEEK_THOUGHTS = '0'; // без монолога, чтобы таймаут случился сразу
  globalThis.fetch = () => new Promise(() => {});
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_timeout');
    assert.equal(body.reply, SOFT);
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevTimeout === undefined) delete process.env.RELAY_TIMEOUT_MS; else process.env.RELAY_TIMEOUT_MS = prevTimeout;
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('DEEPSEEK_THOUGHTS=0 отключает внутренний монолог (один запрос)', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_THOUGHTS = '0';
  const calls = installFetch([deepseekReply('ответ')]);
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.reply, 'ответ');
    assert.equal(body.thought, '');
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('пустой ответ DeepSeek (choices без content) -> deepseek_empty', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_THOUGHTS = '0';
  installFetch([jsonResponse({ choices: [{ message: {} }] })]);
  try {
    const state = await callRelay({ method: 'POST', body: { text: 'привет' } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.error, 'deepseek_empty');
    assert.equal(body.reply, SOFT);
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('checkInitiative -> {ok:true, initiative:true, text}', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_THOUGHTS = '0'; // инициатива всё равно не должна звать монолог
  const calls = installFetch([deepseekReply('ХОЧУ: скучаю, как ты там')]);
  try {
    const state = await callRelay({
      method: 'POST',
      body: {
        checkInitiative: true,
        state: {
          currentState: 'bored',
          userStatus: 'awake',
          lastUserMessageTime: Date.now() - 3600 * 1000,
          messages: [{ role: 'user', content: 'пока' }]
        }
      }
    });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(body.initiative, true);
    assert.equal(body.text, 'скучаю, как ты там');
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.match(sent.messages[0].content, /ХОЧУ/);
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('checkInitiative НЕ ХОЧУ -> {ok:true, initiative:false, reason}', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_THOUGHTS = '0';
  installFetch([deepseekReply('НЕ ХОЧУ: он спит')]);
  try {
    const state = await callRelay({ method: 'POST', body: { checkInitiative: true, state: {} } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, true);
    assert.equal(body.initiative, false);
    assert.equal(body.reason, 'он спит');
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('checkInitiative при ошибке DeepSeek -> JSON с мягким reply, не падаем', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_THOUGHTS = '0';
  installFetch([htmlResponse(200)]);
  try {
    const state = await callRelay({ method: 'POST', body: { checkInitiative: true, state: {} } });
    const body = assertJsonResponse(state, { status: 200 });
    assert.equal(body.ok, false);
    assert.equal(body.initiative, false);
    assert.equal(body.error, 'deepseek_bad_response');
    assert.equal(body.reply, SOFT);
  } finally {
    restoreFetch();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('внутренняя ошибка обработчика -> 500 JSON server_error (никогда не HTML)', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const realJsonParse = JSON.parse;
  // имитируем поломку внутри: тело — объект, у которого history кидает при переборе
  const evil = {
    text: 'привет',
    get history() { throw new Error('boom inside handler'); }
  };
  try {
    const state = await callRelay({ method: 'POST', body: evil });
    const body = assertJsonResponse(state, { status: 500 });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'server_error');
    assert.equal(body.reply, SOFT);
    assert.ok(!JSON.stringify(body).includes('boom inside handler'));
  } finally {
    void realJsonParse;
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
  }
});

/* -------------------------------------------------------------------- worker */

test('worker GET / -> 200 JSON {ok:true} + CORS', async () => {
  const request = new Request('https://masha-relay.test/');
  const response = await workerFetch(request, { DEEPSEEK_API_KEY: 'k' }, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'masha-relay');
  assert.equal(body.hasKey, true);
});

test('worker GET /health -> 200 JSON', async () => {
  const response = await workerFetch(new Request('https://masha-relay.test/health'), {}, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.hasKey, false);
});

test('worker OPTIONS -> 204 + CORS', async () => {
  const response = await workerFetch(new Request('https://masha-relay.test/', { method: 'OPTIONS' }), {}, {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('worker без ключа -> 500 JSON no_api_key', async () => {
  const request = new Request('https://masha-relay.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'привет' })
  });
  const response = await workerFetch(request, {}, {});
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'no_api_key');
  assert.equal(body.reply, SOFT);
});

test('worker невалидный JSON -> 400 JSON bad_json', async () => {
  const request = new Request('https://masha-relay.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'не json'
  });
  const response = await workerFetch(request, { DEEPSEEK_API_KEY: 'k' }, {});
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, 'bad_json');
  assert.equal(body.reply, SOFT);
});

test('worker обычный чат -> {ok:true, reply, thought}', async () => {
  const calls = installFetch([deepseekReply('думаю про него'), deepseekReply('привет, я тут')]);
  try {
    const request = new Request('https://masha-relay.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'привет', systemPrompt: 'Ты Маша', history: [] })
    });
    const response = await workerFetch(request, { DEEPSEEK_API_KEY: 'k' }, {});
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.reply, 'привет, я тут');
    assert.equal(body.thought, 'думаю про него');
    assert.equal(calls.length, 2);
    assert.match(String(calls[0].init.headers.Authorization), /^Bearer k$/);
  } finally {
    restoreFetch();
  }
});

test('worker: DeepSeek HTML -> JSON-ошибка, а не HTML наружу', async () => {
  const calls = installFetch([deepseekReply('думаю'), htmlResponse(200)]);
  try {
    const request = new Request('https://masha-relay.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'привет' })
    });
    const response = await workerFetch(request, { DEEPSEEK_API_KEY: 'k' }, {});
    const text = await response.text();
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.ok(!text.includes('<!DOCTYPE'));
    const body = JSON.parse(text);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_bad_response');
    assert.equal(body.reply, SOFT);
    assert.equal(calls.length, 2);
  } finally {
    restoreFetch();
  }
});

test('worker: DeepSeek 500 -> JSON deepseek_500 с мягким reply', async () => {
  const calls = installFetch([
    deepseekReply('думаю'),
    jsonResponse({ error: 'boom' }, 500),
    jsonResponse({ error: 'boom again' }, 500)
  ]);
  try {
    const request = new Request('https://masha-relay.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'привет',
        history: [{ role: 'assistant', content: 'ага' }, { role: 'user', content: 'ок' }]
      })
    });
    const response = await workerFetch(request, { DEEPSEEK_API_KEY: 'k' }, {});
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'deepseek_500');
    assert.equal(body.reply, SOFT);
    assert.equal(calls.length, 3, 'монолог + попытка с историей + ретрай без истории');
  } finally {
    restoreFetch();
  }
});

test('worker checkInitiative -> {ok:true, initiative:true, text}', async () => {
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_THOUGHTS = '0';
  installFetch([deepseekReply('ХОЧУ: как ты там')]);
  try {
    const request = new Request('https://masha-relay.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkInitiative: true, state: { currentState: 'bored' } })
    });
    const response = await workerFetch(request, { DEEPSEEK_API_KEY: 'k' }, {});
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.initiative, true);
    assert.equal(body.text, 'как ты там');
  } finally {
    restoreFetch();
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});

test('worker: модели из env с дефолтами', async () => {
  const calls = installFetch([deepseekReply('ответ')]);
  const prevThoughts = process.env.DEEPSEEK_THOUGHTS;
  process.env.DEEPSEEK_THOUGHTS = '0';
  try {
    const request = new Request('https://masha-relay.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'привет' })
    });
    await workerFetch(request, { DEEPSEEK_API_KEY: 'k', DEEPSEEK_TEXT_MODEL: 'my-model' }, {});
    assert.equal(JSON.parse(calls[0].init.body).model, 'my-model');
  } finally {
    restoreFetch();
    if (prevThoughts === undefined) delete process.env.DEEPSEEK_THOUGHTS; else process.env.DEEPSEEK_THOUGHTS = prevThoughts;
  }
});
