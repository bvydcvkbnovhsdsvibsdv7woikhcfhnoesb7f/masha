/* Тесты MashaAPI (js/api-client.js) — это тот самый слой, который убирает
   «Unexpected token '<', '<!DOCTYPE' ... is not valid JSON» и умеет
   переключаться на резервный сервер, если основной лёг. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/* Фейковый localStorage — модуль хранит в нём адреса и статистику. */
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  clear: () => store.clear()
};
globalThis.location = { origin: 'https://masha.test', hostname: 'masha.test', protocol: 'https:' };

const require = createRequire(import.meta.url);
const MashaAPI = require('../js/api-client.js');

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function htmlResponse(status = 200) {
  return new Response('<!DOCTYPE html><html><body>index page</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function use(handler, endpoints) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  MashaAPI.setEndpoints(endpoints);
  MashaAPI.resetCooldowns();
  return calls;
}

const GOOD = { ok: true, reply: 'привет, мальчик мой', thought: 'думаю о нём' };

test('HTML вместо JSON (200) — понятная ошибка, а не падение', async () => {
  use(() => htmlResponse(200), ['https://masha.test/api/relay']);
  await assert.rejects(
    () => MashaAPI.chat({ text: 'привет' }),
    err => {
      assert.equal(err.code, 'bad_json');
      assert.match(err.friendly, /не JSON/i);
      return true;
    }
  );
});

test('HTML 404 — код http_404 и человеческое пояснение', async () => {
  use(() => htmlResponse(404), ['https://masha.test/api/relay']);
  await assert.rejects(
    () => MashaAPI.chat({ text: 'привет' }),
    err => {
      assert.equal(err.code, 'http_404');
      assert.match(err.friendly, /не найден/i);
      return true;
    }
  );
});

test('первый сервер лёг — запрос уходит на второй (независимость от хостинга)', async () => {
  const calls = use((url) => (url.includes('primary') ? htmlResponse(200) : jsonResponse(GOOD)),
    ['https://primary.test/api/relay', 'https://backup.test/api/relay']);

  const data = await MashaAPI.chat({ text: 'привет' });
  assert.equal(data.reply, GOOD.reply);
  assert.match(data.__endpoint, /backup/);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /primary/);
  assert.match(calls[1].url, /backup/);
  assert.equal(calls[0].options.method, 'POST');
});

test('все серверы недоступны — наружу последняя причина, список попыток сохранён', async () => {
  use(() => htmlResponse(200), ['https://a.test/api/relay', 'https://b.test/api/relay']);
  await assert.rejects(
    () => MashaAPI.chat({ text: 'привет' }),
    err => {
      assert.equal(err.code, 'bad_json');
      assert.equal(err.tried.length, 2);
      assert.match(err.friendly, /не JSON/i);
      return true;
    }
  );
});

test('упавший сервер уходит в конец очереди (cooldown)', async () => {
  const calls = use((url) => (url.includes('bad') ? htmlResponse(200) : jsonResponse(GOOD)),
    ['https://bad.test/api/relay', 'https://good.test/api/relay']);

  await MashaAPI.chat({ text: 'раз' });     // bad падает → good отвечает
  const afterFirst = calls.length;
  await MashaAPI.chat({ text: 'два' });     // bad в cooldown → сразу good
  assert.equal(calls.length, afterFirst + 1);
  assert.match(calls[calls.length - 1].url, /good/);
});

test('мягкая ошибка релея (200 + ok:false + reply) доходит до UI', async () => {
  use(() => jsonResponse({
    ok: false, error: 'deepseek_500',
    message: 'AI-сервер не ответил', reply: 'блин, у меня чето связь пропала, давай еще раз?'
  }), ['https://masha.test/api/relay']);

  const data = await MashaAPI.chat({ text: 'привет' });
  assert.equal(data.__softError, 'deepseek_500');
  assert.match(data.reply, /связь пропала/);
  assert.match(MashaAPI.friendlyMessage('deepseek_timeout'), /вовремя/i);
});

test('health(): живой сервер и HTML-заглушка различаются', async () => {
  use((url) => (url.includes('dead') ? htmlResponse(200) : jsonResponse({ ok: true, service: 'masha-relay', hasKey: true })),
    ['https://live.test/api/relay', 'https://dead.test/api/relay']);

  const results = await MashaAPI.healthAll();
  const live = results.find(r => r.endpoint.includes('live'));
  const dead = results.find(r => r.endpoint.includes('dead'));
  assert.equal(live.ok, true);
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'bad_json');
  assert.equal(typeof live.latencyMs, 'number');
});

test('инициатива: обычный ответ и мягкая ошибка', async () => {
  use(() => jsonResponse({ ok: true, initiative: true, text: 'привет, ты тут?' }),
    ['https://masha.test/api/relay']);
  const data = await MashaAPI.initiative({ messages: [] });
  assert.equal(data.initiative, true);
  assert.equal(data.text, 'привет, ты тут?');

  use(() => jsonResponse({ ok: false, error: 'deepseek_timeout', message: 'таймаут', reply: '...' }),
    ['https://masha.test/api/relay']);
  const soft = await MashaAPI.initiative({ messages: [] });
  assert.equal(soft.ok, false);
  assert.equal(soft.message, 'таймаут');
});

test('на веб-домене добавляется свой /api/relay, в APK (localhost) — нет', async () => {
  store.delete('masha_endpoints');
  globalThis.MASHA_DEFAULT_ENDPOINTS = ['https://remote.test/api/relay'];

  globalThis.location = { origin: 'https://masha.test', hostname: 'masha.test', protocol: 'https:' };
  const web = MashaAPI.loadEndpoints();
  assert.equal(web[0], 'https://masha.test/api/relay');
  assert.ok(web.includes('https://remote.test/api/relay'));

  // В APK origin — https://localhost, свой /api/relay там отдал бы index.html,
  // поэтому он не добавляется: идём сразу на внешний релей.
  globalThis.location = { origin: 'https://localhost', hostname: 'localhost', protocol: 'https:' };
  const apk = MashaAPI.loadEndpoints();
  assert.deepEqual(apk, ['https://remote.test/api/relay']);

  globalThis.location = { origin: 'https://masha.test', hostname: 'masha.test', protocol: 'https:' };
  delete globalThis.MASHA_DEFAULT_ENDPOINTS;
});

test('адреса из localStorage имеют приоритет над значениями по умолчанию', async () => {
  store.set('masha_endpoints', JSON.stringify(['https://my-own.test/api/relay']));
  globalThis.MASHA_DEFAULT_ENDPOINTS = ['https://ignored.test/api/relay'];
  const list = MashaAPI.loadEndpoints();
  assert.equal(list.length, 1);
  assert.equal(list[0], 'https://my-own.test/api/relay');
  store.delete('masha_endpoints');
  delete globalThis.MASHA_DEFAULT_ENDPOINTS;
});

test('нет интернета (navigator.onLine=false) — код offline, запрос не уходит', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse(GOOD); };
  MashaAPI.setEndpoints(['https://masha.test/api/relay']);

  let patched = false;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    patched = true;
  } catch (e) { patched = false; }

  if (!patched) return; // окружение не даёт подменить navigator — пропускаем
  await assert.rejects(
    () => MashaAPI.chat({ text: 'привет' }),
    err => {
      assert.equal(err.code, 'offline');
      return true;
    }
  );
  assert.equal(called, false);
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
});
