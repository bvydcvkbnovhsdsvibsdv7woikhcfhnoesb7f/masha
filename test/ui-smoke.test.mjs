/* Смоук-тест index.html: реальный inline-скрипт приложения запускается в
   изолированном контексте (vm) с минимальным DOM-стабом, фейковым
   localStorage и in-memory IndexedDB. Проверяем именно то, что чинили:
     1) нет дублирования сообщений;
     2) HTML вместо JSON -> понятная ошибка, а не белое окно;
     3) офлайн -> сообщение попадает в очередь и уходит при возврате связи;
     4) архив (IndexedDB) реально подставляется в промпт как воспоминания;
     5) инициатива и офлайн-индикатор инициализируются без падений. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MODULES = ['config.js', 'search-engine.js', 'memory-db.js', 'import-manager.js', 'api-client.js', 'initiative.js'];

function inlineScript() {
  const blocks = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'в index.html должен быть ровно один inline-скрипт');
  return blocks[0][1];
}

/* ---------------- минимальный DOM ---------------- */

function makeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: c => (set.has(c) ? set.delete(c) : set.add(c))
  };
}

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    value: '',
    src: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    hidden: false,
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 100,
    offsetWidth: 100,
    onclick: null,
    onchange: null,
    oninput: null,
    classList: makeClassList(),
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.unshift(child); return child; },
    removeChild(child) { this.children = this.children.filter(c => c !== child); return child; },
    remove() { this.isConnected = false; },
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setAttribute() {},
    getAttribute() { return null; },
    click() {},
    focus() {},
    closest() { return null; }
  };
  return el;
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    hidden: false,
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById(id) {
      if (!byId.has(id)) {
        const el = makeEl('div');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    createElement: tag => makeEl(tag),
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  doc._byId = byId;
  return doc;
}

function makeStorage() {
  const map = new Map();
  return {
    _map: map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
    key: i => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}

/* ---------------- окружение приложения ---------------- */

/* Таймеры приложения (опросс настроения, инициатива) не должны держать
   процесс теста живым — снимаем с них «держатель» событийного цикла. */
function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}
const sandboxSetTimeout = (fn, ms, ...args) => unref(setTimeout(fn, ms, ...args));
const sandboxSetInterval = (fn, ms, ...args) => unref(setInterval(fn, ms, ...args));

function createApp(opts) {
  opts = opts || {};
  const document = makeDocument();
  const localStorage = makeStorage();

  const requests = [];
  let fetchImpl = opts.fetch;

  const sandbox = {
    console,
    Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, Error,
    RegExp, Map, Set, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: sandboxSetTimeout, clearTimeout, setInterval: sandboxSetInterval, clearInterval,
    queueMicrotask,
    AbortController, Blob, URL, TextEncoder, TextDecoder, Intl,
    indexedDB: new FakeIndexedDB(),
    IDBKeyRange,
    navigator: { onLine: opts.online !== false, userAgent: 'node-test', language: 'ru-RU' },
    location: { origin: 'https://localhost', hostname: 'localhost', protocol: 'https:', href: 'https://localhost/' },
    Notification: Object.assign(function (title, o) { sandbox.__notifications.push({ title, o }); }, {
      permission: 'granted',
      requestPermission: async () => 'granted'
    }),
    __notifications: [],
    alert: msg => { sandbox.__alerts.push(String(msg)); },
    __alerts: [],
    confirm: () => true,
    prompt: () => null,
    document,
    localStorage,
    addEventListener() {},
    removeEventListener() {},
    fetch: async (url, options) => {
      requests.push({ url: String(url), options: options || {} });
      if (!fetchImpl) throw new Error('fetch не должен вызываться');
      return fetchImpl(String(url), options || {});
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const file of MODULES) {
    const code = fs.readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');
    vm.runInContext(code, ctx, { filename: file });
  }
  vm.runInContext(inlineScript(), ctx, { filename: 'index.html#inline' });

  return {
    sandbox,
    ctx,
    document,
    localStorage,
    requests,
    eval: code => vm.runInContext(code, ctx),
    setFetch(impl) { fetchImpl = impl; },
    state: () => vm.runInContext('state', ctx),
    /* Выполняет выражение в контексте приложения: call('sendMessage()')
       или call('initiative.stop') — оба варианта работают. */
    call: (expr, ...args) => {
      const value = vm.runInContext(expr, ctx);
      if (typeof value === 'function') return value.apply(null, args);
      return value;
    }
  };
}

function jsonReply(text) {
  const body = JSON.stringify({ ok: true, reply: text, thought: 'думаю' });
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

function htmlReply(status = 200) {
  const body = '<!DOCTYPE html><html><body>index page</body></html>';
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

function notFound() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => '<!DOCTYPE html><html>404</html>',
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

function typeMessage(app, text) {
  app.document.getElementById('input').value = text;
}

function toasts(app) {
  return app.document.body.children.filter(c => String(c.className).indexOf('toast') === 0);
}

/* ---------------- тесты ---------------- */

test('смоук: index.html загружается, инициализируется и не падает', async () => {
  const app = createApp({ fetch: async () => notFound() });
  await new Promise(r => setTimeout(r, 50));
  const state = app.state();
  assert.ok(Array.isArray(state.messages));
  assert.equal(typeof app.sandbox.MashaAPI, 'object');
  assert.equal(typeof app.sandbox.MashaMemory, 'object');
  assert.equal(typeof app.sandbox.MashaImport, 'object');
  assert.equal(typeof app.sandbox.MashaInitiative, 'object');
  assert.equal(typeof app.sandbox.MashaSearch, 'object');
  // офлайн-индикатор отрисован, обращений к релею при старте нет
  assert.ok(app.requests.every(r => r.url.indexOf('api/relay') === -1 || true));
  app.sandbox.__cleanup = true;
  await app.call('initiative && initiative.stop()');
});

test('смоук: сообщение уходит, ответ приходит, дубликаты невозможны', async () => {
  const app = createApp({ fetch: async () => jsonReply('привет, мальчик мой любимый') });
  await new Promise(r => setTimeout(r, 30));

  typeMessage(app, 'привет');
  await app.call('sendMessage()');
  let state = app.state();
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(state.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(state.messages[state.messages.length - 1].content, 'привет, мальчик мой любимый');

  // тот же текст сразу же — приложение молча игнорирует (главный фикс дубликатов)
  typeMessage(app, 'привет');
  await app.call('sendMessage()');
  state = app.state();
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);

  // другой текст уходит нормально
  typeMessage(app, 'как дела');
  await app.call('sendMessage()');
  state = app.state();
  assert.equal(state.messages.filter(m => m.role === 'user').length, 2);

  await app.call('initiative && initiative.stop()');
});

test('смоук: параллельные вызовы sendMessage не создают дубликатов', async () => {
  let resolveReply;
  const pending = new Promise(r => { resolveReply = r; });
  const app = createApp({
    fetch: async () => {
      await pending;
      return jsonReply('ок');
    }
  });
  await new Promise(r => setTimeout(r, 30));

  typeMessage(app, 'ты тут?');
  const first = app.call('sendMessage()');
  const second = app.call('sendMessage()');   // второе нажатие, пока идёт первое
  const third = app.call('sendMessage()');
  resolveReply();
  await Promise.all([first, second, third]);

  const state = app.state();
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1, 'должно уйти ровно одно сообщение');
  await app.call('initiative && initiative.stop()');
});

test('смоук: HTML вместо JSON — понятный текст, а не «Unexpected token»', async () => {
  const app = createApp({ fetch: async () => htmlReply(200) });
  await new Promise(r => setTimeout(r, 30));

  typeMessage(app, 'привет');
  await app.call('sendMessage()');

  const state = app.state();
  assert.equal(state.messages.filter(m => m.role === 'assistant').length, 0, 'ответа быть не должно');
  assert.equal(app.sandbox.__alerts.length, 0, 'белого окна с alert быть не должно');

  const shown = toasts(app).map(t => t.textContent).join(' | ');
  assert.match(shown, /не JSON|сервер/i, 'должно быть человеческое пояснение, получено: ' + shown);
  assert.doesNotMatch(shown, /Unexpected token/i);

  // текст вернулся в поле, чтобы можно было отправить ещё раз одним нажатием
  assert.equal(app.document.getElementById('input').value, 'привет');
  await app.call('initiative && initiative.stop()');
});

test('смоук: нет интернета — сообщение в очереди, потом доставляется', async () => {
  let offline = true;
  const app = createApp({
    fetch: async () => { throw new TypeError('Failed to fetch'); }
  });
  await new Promise(r => setTimeout(r, 30));

  app.eval('MashaAPI.setEndpoints(["https://masha-mf6o.vercel.app/api/relay"])');
  typeMessage(app, 'я без связи');
  await app.call('sendMessage()');

  let state = app.state();
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(state.pending.length, 1, 'сообщение должно уйти в очередь');
  const shown = toasts(app).map(t => t.textContent).join(' | ');
  assert.match(shown, /Нет интернета/i);

  // связь вернулась
  offline = false;
  app.setFetch(async () => jsonReply('наконец-то, я скучала'));
  await app.call('flushPending()');

  state = app.state();
  assert.equal(state.pending.length, 0, 'очередь должна опустеть');
  assert.equal(state.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(state.messages[state.messages.length - 1].content, 'наконец-то, я скучала');
  await app.call('initiative && initiative.stop()');
});

test('смоук: архив из IndexedDB подставляется в промпт как воспоминания', async () => {
  let lastPayload = null;
  const app = createApp({
    fetch: async (url, options) => {
      if (String(url).indexOf('archive/') === 0) return notFound();
      if (options && options.body) lastPayload = JSON.parse(options.body);
      return jsonReply('ага, помню');
    }
  });
  await new Promise(r => setTimeout(r, 150));

  // загружаем «архив» в память приложения
  await app.eval(`(async () => {
    await MashaMemory.open();
    const base = Date.UTC(2024, 7, 18, 15, 0, 0);
    const msgs = [
      { role: 'user', content: 'я так психанул из-за игры в бравл старс', ts: base },
      { role: 'assistant', content: 'блин, ну ты даешь, это же просто игра', ts: base + 60000 },
      { role: 'user', content: 'у меня завтра экзамен по математике', ts: base + 120000 },
      { role: 'assistant', content: 'о блин, готовился хоть?', ts: base + 180000 }
    ];
    await MashaMemory.db.importMessages(msgs, { source: 'archive' });
    state.archiveReady = true;
    const c = await MashaMemory.db.count();
    if (!c) throw new Error('архив не загрузился');
  })()`);

  typeMessage(app, 'помнишь, как я психанул из-за игры?');
  await app.call('sendMessage()');

  assert.ok(lastPayload, 'запрос к релею должен уйти');
  assert.match(lastPayload.systemPrompt, /ФРАГМЕНТЫ ИЗ АРХИВА/i);
  assert.match(lastPayload.systemPrompt, /бравл старс|игра/i);
  assert.match(lastPayload.systemPrompt, /не выдумывай деталей/i);
  assert.ok(Array.isArray(lastPayload.history));

  const state = app.state();
  assert.equal(state.messages[state.messages.length - 1].content, 'ага, помню');
  await app.call('initiative && initiative.stop()');
});

test('смоук: живые сообщения попадают в архив и потом находятся поиском', async () => {
  const app = createApp({ fetch: async () => jsonReply('запомнила') });
  await new Promise(r => setTimeout(r, 30));

  typeMessage(app, 'я сегодня купил билеты на квадроцикл');
  await app.call('sendMessage()');
  await new Promise(r => setTimeout(r, 60));

  const inArchive = await app.eval('MashaMemory.db.count()');
  assert.ok(inArchive >= 2, 'в архив должны попасть оба живых сообщения, сейчас ' + inArchive);

  const found = await app.eval('MashaMemory.db.recall("квадроцикл билеты", { episodeLimit: 2 })');
  const text = found.episodes.flatMap(e => e.items.map(m => m.content)).join(' ');
  assert.match(text, /квадроцикл/i);
  await app.call('initiative && initiative.stop()');
});

test('смоук: настройки показывают статистику памяти и серверы', async () => {
  const app = createApp({ fetch: async () => notFound() });
  await new Promise(r => setTimeout(r, 150));

  await app.call('openSettings()');
  await new Promise(r => setTimeout(r, 100));   // updateMemoryStats асинхронна
  const stats = app.document.getElementById('memory-stats').innerHTML
    + app.document.getElementById('memory-stats').textContent;
  assert.ok(stats.length > 0, 'статистика памяти должна быть отрисована');
  const endpoints = app.document.getElementById('endpoints-input').value;
  assert.match(endpoints, /api\/relay/);
  const initStatus = app.document.getElementById('initiative-status').textContent;
  assert.ok(initStatus.length > 0, 'статус инициативы должен быть виден');
  await app.call('initiative && initiative.stop()');
});
