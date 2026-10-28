/* Релей (Cloudflare/Deno/Netlify/Vercel) и клиент API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const worker = (await import(pathToFileURL(path.join(ROOT, 'worker', 'worker.js')).href)).default;

function deepSeekReply(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

test('worker: GET — диагностика с ключом и без', async () => {
  const withKey = await worker.fetch(new Request('https://relay.test/', { method: 'GET' }), { DEEPSEEK_API_KEY: 'k' }, {});
  assert.equal(withKey.status, 200);
  assert.match(withKey.headers.get('content-type'), /application\/json/);
  const data = await withKey.json();
  assert.equal(data.ok, true);
  assert.equal(data.hasKey, true);
  assert.equal(data.service, 'masha-relay');

  const noKey = await worker.fetch(new Request('https://relay.test/health', { method: 'GET' }), {}, {});
  assert.equal((await noKey.json()).hasKey, false);
});

test('worker: OPTIONS -> 204 с CORS, PUT -> 405 JSON (не HTML)', async () => {
  const pre = await worker.fetch(new Request('https://relay.test/', { method: 'OPTIONS' }), {}, {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');

  const put = await worker.fetch(new Request('https://relay.test/', { method: 'PUT', body: 'x' }), {}, {});
  assert.equal(put.status, 405);
  assert.equal((await put.json()).ok, false);
});

test('worker: нет ключа и битый JSON — всегда JSON', async () => {
  const noKey = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'привет' })
  }), {}, {});
  assert.equal(noKey.status, 500);
  const d1 = await noKey.json();
  assert.equal(d1.error, 'no_api_key');
  assert.ok(d1.reply, 'должна быть мягкая фраза Маши');

  const bad = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{не json'
  }), { DEEPSEEK_API_KEY: 'k' }, {});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_json');
});

test('worker: обычный чат и история санитизируется', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return deepSeekReply('привет, зая');
  };
  const res = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'привет',
      systemPrompt: 'Ты Маша',
      history: [{ role: 'bot', content: 'ага' }, { role: 'x', content: 'мусор' }, { role: 'user', content: '' }],
      checkInitiative: false
    })
  }), { DEEPSEEK_API_KEY: 'k', DEEPSEEK_THOUGHTS: '0' }, {});
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.reply, 'привет, зая');
  const sent = calls[calls.length - 1].messages;
  assert.equal(sent[0].role, 'system');
  assert.ok(sent.every(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant'));
  assert.ok(!sent.some(m => m.content === 'мусор'));
});

test('worker: DeepSeek отдаёт HTML или падает — наружу всё равно JSON', async () => {
  globalThis.fetch = async () => new Response('<!DOCTYPE html><html>ошибка</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const res = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'привет', systemPrompt: 's' })
  }), { DEEPSEEK_API_KEY: 'k', DEEPSEEK_THOUGHTS: '0' }, {});
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.error, /deepseek_/);
  assert.ok(data.reply);

  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const res2 = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'привет' })
  }), { DEEPSEEK_API_KEY: 'k', DEEPSEEK_THOUGHTS: '0' }, {});
  assert.equal((await res2.json()).error, 'deepseek_unreachable');
});

test('worker: инициатива парсится в ХОЧУ / НЕ ХОЧУ', async () => {
  globalThis.fetch = async () => deepSeekReply('ХОЧУ: привет, ты тут?');
  const yes = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkInitiative: true, state: {} })
  }), { DEEPSEEK_API_KEY: 'k' }, {});
  const d1 = await yes.json();
  assert.equal(d1.initiative, true);
  assert.equal(d1.text, 'привет, ты тут?');

  globalThis.fetch = async () => deepSeekReply('НЕ ХОЧУ: он спит');
  const no = await worker.fetch(new Request('https://relay.test/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkInitiative: true, state: {} })
  }), { DEEPSEEK_API_KEY: 'k' }, {});
  const d2 = await no.json();
  assert.equal(d2.initiative, false);
  assert.match(d2.reason, /спит/);
});

test('Deno-адаптер отвечает JSON на GET', async () => {
  const code = fs.readFileSync(path.join(ROOT, 'worker', 'deno-relay.js'), 'utf8');
  let handler = null;
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Deno: { serve: (fn) => { handler = fn; }, env: { get: (k) => (k === 'DEEPSEEK_API_KEY' ? 'k' : undefined) } },
    Request, Response, Headers, AbortController, URL, TextEncoder, TextDecoder, fetch,
    setTimeout, clearTimeout, JSON, Math, Date, Object, Array, String, Number, Boolean, Error,
    RegExp, Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'deno-relay.js' });
  assert.equal(typeof handler, 'function');
  const res = await handler(new Request('https://demo.deno.dev/', { method: 'GET' }));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.hasKey, true);
  assert.equal(data.host, 'cloudflare-worker');
});

test('Netlify-адаптер отвечает JSON на GET', async () => {
  const fnPath = path.join(ROOT, 'worker', 'netlify-relay.js');
  delete require.cache[fnPath];
  const fn = require(fnPath);
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'k';
  try {
    const out = await fn.handler({ httpMethod: 'GET', path: '/.netlify/functions/relay', headers: { host: 'demo.netlify.app' }, body: null });
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.equal(data.ok, true);
    assert.equal(data.hasKey, true);
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('Vercel-адаптер (api/relay.js) работает как (req, res)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'relay.js'), 'utf8');
  assert.ok(src.includes('export default async function handler'), 'должен быть Vercel-обработчик');
  const tmp = path.join(os.tmpdir(), 'masha-relay-' + Date.now() + '.mjs');
  fs.writeFileSync(tmp, src, 'utf8');
  const mod = await import(pathToFileURL(tmp).href);
  assert.equal(typeof mod.default, 'function');

  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; }
  };
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'k';
  try {
    await mod.default({ method: 'GET', url: '/api/relay', headers: { host: 'masha.vercel.app' } }, res);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.hasKey, true);
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved;
    fs.unlinkSync(tmp);
  }
});

/* ------------------------------- клиент API ------------------------------- */

function loadApiClient() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear()
  };
  globalThis.location = { origin: 'https://masha.test', hostname: 'masha.test', protocol: 'https:' };
  const p = require.resolve('../js/api-client.js');
  delete require.cache[p];
  return { api: require('../js/api-client.js'), store };
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function htmlRes(status = 200) {
  return new Response('<!DOCTYPE html><html>страница</html>', { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

test('клиент: HTML вместо JSON — понятная ошибка, запрос уходит на второй сервер', async () => {
  const { api } = loadApiClient();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes('primary') ? htmlRes(200) : jsonRes({ ok: true, reply: 'и я тебя' });
  };
  api.setEndpoints(['https://primary.test/api/relay', 'https://backup.test/api/relay']);
  api.resetCooldowns();

  const data = await api.chat({ text: 'привет' });
  assert.equal(data.reply, 'и я тебя');
  assert.match(data.__endpoint, /backup/);
  assert.ok(calls.length >= 2, 'попытки: ' + calls.join(', '));

  // 404 HTML -> код http_404 с понятным текстом
  api.setEndpoints(['https://dead.test/api/relay']);
  api.resetCooldowns();
  globalThis.fetch = async () => htmlRes(404);
  await assert.rejects(() => api.chat({ text: 'привет' }), err => {
    assert.equal(err.code, 'http_404');
    assert.match(err.friendly, /нет релея/i);
    return true;
  });
  assert.ok(api.cooldownLeftMs('https://dead.test/api/relay') > 5 * 60 * 1000, 'мёртвый адрес блокируется');
});

test('клиент: рабочий сервер запоминается и пробуется первым', async () => {
  const { api } = loadApiClient();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes('slow') ? htmlRes(200) : jsonRes({ ok: true, reply: 'ок' });
  };
  api.setEndpoints(['https://slow.test/api/relay', 'https://fast.test/api/relay']);
  api.resetCooldowns();
  await api.chat({ text: 'раз' });
  api.resetCooldowns();
  calls.length = 0;
  const data = await api.chat({ text: 'два' });
  assert.match(data.__endpoint, /fast/);
  assert.equal(calls.length, 1, 'должны сразу идти на рабочий сервер');
});

test('worker: проверка здоровья работает и через POST (для адресов со статикой)', async () => {
  const res = await worker.fetch(new Request('https://relay.test/api/relay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ health: true })
  }), { DEEPSEEK_API_KEY: 'k' }, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, 'masha-relay');
  assert.equal(data.hasKey, true);
  assert.ok(data.models.text);
});

test('клиент: сервер без ключа не мешает — запрос уходит на следующий', async () => {
  const { api } = loadApiClient();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('nokey')) {
      return jsonRes({ ok: false, error: 'no_api_key', message: 'нет ключа', reply: 'блин, у меня чето связь пропала, давай еще раз?' }, 500);
    }
    return jsonRes({ ok: true, reply: 'и я тебя🫶' });
  };
  api.setEndpoints(['https://nokey.test/api/relay', 'https://good.test/api/relay']);
  api.resetCooldowns();
  const data = await api.chat({ text: 'привет' });
  assert.equal(data.reply, 'и я тебя🫶');
  assert.match(data.__endpoint, /good/);
  assert.equal(calls.length, 2, 'должны были попробовать оба адреса');

  // если ВСЕ без ключа — показываем её мягкую фразу, а не техническую ошибку
  api.resetCooldowns();
  api.setEndpoints(['https://nokey.test/api/relay']);
  const soft = await api.chat({ text: 'привет' });
  assert.equal(soft.__softError, 'no_api_key');
  assert.match(soft.reply, /связь пропала/);
});

test('клиент: по адресу живёт сайт (GET=HTML) — проверка уходит POST-ом и видит релей', async () => {
  const { api } = loadApiClient();
  let posts = 0;
  globalThis.fetch = async (url, options) => {
    const method = (options && (options.method || (options.body ? 'POST' : 'GET'))) || 'GET';
    if (method === 'GET') return htmlRes(200);           // страница-заглушка сайта
    posts++;
    return jsonRes({ ok: true, service: 'masha-relay', hasKey: true });
  };
  api.setEndpoints(['https://masha.test/']);
  api.resetCooldowns();
  const results = await api.healthAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].friendly || results[0].code);
  assert.equal(results[0].data.hasKey, true);
  assert.equal(posts, 1, 'должен быть ровно один POST-запрос');

  // а если релей честно отвечает ошибкой — проверка это покажет
  globalThis.fetch = async (url, options) => (options && options.method === 'GET'
    ? htmlRes(200)
    : jsonRes({ ok: false, error: 'no_api_key', message: 'в воркере нет ключа' }));
  api.resetCooldowns();
  const bad = (await api.healthAll())[0];
  assert.equal(bad.ok, false);
  assert.match(bad.friendly, /ключа|no_api_key/);
});

test('клиент: на GitHub Pages свой /api/relay не подставляется и вычищается', () => {
  const { api, store } = loadApiClient();
  store.delete('masha_endpoints');
  globalThis.MASHA_DEFAULT_ENDPOINTS = ['https://my-relay.workers.dev'];
  globalThis.location = { origin: 'https://user.github.io', hostname: 'user.github.io', protocol: 'https:' };
  assert.equal(api.isStaticHost(), true);
  assert.deepEqual(api.loadEndpoints(), ['https://my-relay.workers.dev']);

  store.set('masha_endpoints', JSON.stringify(['https://user.github.io/api/relay', 'https://my-relay.workers.dev']));
  assert.deepEqual(api.loadEndpoints(), ['https://my-relay.workers.dev']);

  // на Vercel свой /api/relay остаётся первым
  globalThis.location = { origin: 'https://masha.vercel.app', hostname: 'masha.vercel.app', protocol: 'https:' };
  store.delete('masha_endpoints');
  assert.equal(api.loadEndpoints()[0], 'https://masha.vercel.app/api/relay');

  store.delete('masha_endpoints');
  globalThis.MASHA_DEFAULT_ENDPOINTS = [];
});

test('клиент: офлайн, мягкие ошибки и status()', async () => {
  const { api } = loadApiClient();
  api.setEndpoints(['https://relay.test/api/relay']);
  api.resetCooldowns();

  globalThis.fetch = async () => jsonRes({ ok: false, error: 'deepseek_500', message: 'AI не ответил', reply: 'блин, чето связь пропала' });
  const soft = await api.chat({ text: 'привет' });
  assert.equal(soft.__softError, 'deepseek_500');
  assert.match(soft.reply, /связь пропала/);

  globalThis.fetch = async () => htmlRes(200);
  await assert.rejects(() => api.chat({ text: 'привет' }));
  const st = api.status();
  assert.equal(st.allDead, true, 'после ошибки сервер считается недоступным');
  api.resetCooldowns();
  assert.equal(api.status().allDead, false);
});

test('клиент: адрес воркера с /api/relay, отдающий HTML, сам находит рабочий путь', async () => {
  // эмулируем реальную ситуацию: у воркера GET живёт только на «/», а по /api/relay
  // приходит HTML-страница. Клиент должен сам попробовать «/» и получить JSON.
  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/relay')) {
      return new Response('<!DOCTYPE html><html>not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(JSON.stringify({ ok: true, service: 'masha-relay', hasKey: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const api = require('../js/api-client.js');
    const res = await api.health('https://masha.test.workers.dev/api/relay', 3000);
    assert.equal(res.ok, true, 'должен найти рабочий путь: ' + JSON.stringify(res));
    assert.match(res.endpoint, /masha\.test\.workers\.dev\/?$/, 'запомнил рабочий адрес: ' + res.endpoint);
    assert.ok(calls.length >= 2, 'было больше одной попытки');
  } finally {
    globalThis.fetch = origFetch;
  }
});