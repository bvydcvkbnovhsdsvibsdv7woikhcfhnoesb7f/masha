/* Смоук-тест index.html: запускаем настоящий inline-скрипт в vm с мини-DOM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MODULES = ['config.js', 'search-engine.js', 'memory-db.js', 'import-manager.js', 'api-client.js', 'initiative.js'];

function inlineScript() {
  const blocks = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'должен быть ровно один inline-скрипт');
  return blocks[0][1];
}

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), id: '', className: '', style: {}, children: [],
    value: '', src: '', textContent: '', innerHTML: '', checked: false, disabled: false, hidden: false,
    scrollTop: 0, scrollHeight: 100, offsetWidth: 100, onclick: null,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    remove() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, click() {}
  };
}

function makeDocument() {
  const byId = new Map();
  return {
    hidden: false, body: makeEl('body'),
    getElementById(id) {
      if (!byId.has(id)) { const e = makeEl('div'); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    createElement: t => makeEl(t),
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}
  };
}

function unref(t) { if (t && typeof t.unref === 'function') t.unref(); return t; }

function createApp(opts) {
  opts = opts || {};
  const document = makeDocument();
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear()
  };
  const requests = [];
  let fetchImpl = opts.fetch || (async () => { throw new Error('fetch не ожидался'); });

  const sandbox = {
    console, Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, Intl, AbortController, Blob, URL,
    TextEncoder, TextDecoder,
    setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)),
    setInterval: (fn, ms, ...a) => unref(setInterval(fn, ms, ...a)),
    clearTimeout, clearInterval, queueMicrotask,
    indexedDB: new FakeIndexedDB(), IDBKeyRange,
    navigator: { onLine: true, userAgent: 'node-test' },
    location: { origin: 'https://localhost', hostname: 'localhost', protocol: 'https:', href: 'https://localhost/' },
    Notification: Object.assign(function () {}, { permission: 'granted', requestPermission: async () => 'granted' }),
    __alerts: [],
    alert: m => { sandbox.__alerts.push(String(m)); },
    confirm: () => true,
    document, localStorage,
    addEventListener() {}, removeEventListener() {},
    fetch: async (url, options) => {
      requests.push({ url: String(url), options: options || {} });
      return fetchImpl(String(url), options || {});
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const file of MODULES) {
    vm.runInContext(fs.readFileSync(new URL('../js/' + file, import.meta.url), 'utf8'), ctx, { filename: file });
  }
  vm.runInContext(inlineScript(), ctx, { filename: 'index.html#inline' });

  return {
    sandbox, document, requests,
    eval: code => vm.runInContext(code, ctx),
    setFetch(fn) { fetchImpl = fn; },
    state: () => vm.runInContext('state', ctx),
    call: (expr, ...args) => {
      const v = vm.runInContext(expr, ctx);
      return typeof v === 'function' ? v.apply(null, args) : v;
    }
  };
}

function jsonReply(text) {
  const body = JSON.stringify({ ok: true, reply: text, thought: 'думаю' });
  return { ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}
function htmlReply(status = 200) {
  const body = '<!DOCTYPE html><html>страница</html>';
  return { ok: status < 400, status, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}
function notFound() {
  return { ok: false, status: 404, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => '<!DOCTYPE html><html>404</html>', arrayBuffer: async () => new ArrayBuffer(0) };
}

function textOf(el) {
  const out = [];
  const walk = n => { if (!n) return; if (typeof n.textContent === 'string' && n.textContent) out.push(n.textContent); (n.children || []).forEach(walk); };
  walk(el);
  return out.join(' | ');
}
function findButton(root, label) {
  let found = null;
  const walk = n => {
    if (!n || found) return;
    if (String(n.tagName) === 'BUTTON' && String(n.textContent) === label) { found = n; return; }
    (n.children || []).forEach(walk);
  };
  walk(root);
  return found;
}
function type(app, text) { app.document.getElementById('input').value = text; }

test('index.html загружается и инициализируется', async () => {
  const app = createApp({ fetch: async () => notFound() });
  await new Promise(r => setTimeout(r, 80));
  assert.ok(Array.isArray(app.state().messages));
  for (const name of ['MashaAPI', 'MashaMemory', 'MashaImport', 'MashaInitiative', 'MashaSearch']) {
    assert.equal(typeof app.sandbox[name], 'object', 'нет модуля ' + name);
  }
  assert.match(app.eval('DEFAULT_PROMPT'), /Вика/);
  assert.match(app.eval('DEFAULT_PROMPT'), /-_-(?!\()/);
  await app.call('initiative && initiative.stop()');
});

test('сообщение уходит, дубликаты невозможны', async () => {
  const app = createApp({ fetch: async () => jsonReply('привет, мальчик мой любимый') });
  await new Promise(r => setTimeout(r, 60));
  type(app, 'привет');
  await app.call('sendMessage()');
  let st = app.state();
  assert.equal(st.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(st.messages[st.messages.length - 1].content, 'привет, мальчик мой любимый');

  type(app, 'привет');
  await app.call('sendMessage()');
  st = app.state();
  assert.equal(st.messages.filter(m => m.role === 'user').length, 1, 'дубликат не должен уйти');
  await app.call('initiative && initiative.stop()');
});

test('промпт: версия подставляется автоматически, свой текст не затирается', async () => {
  const app = createApp({ fetch: async () => notFound() });
  await new Promise(r => setTimeout(r, 60));

  // свежая установка: промпт отмечается текущей версией и содержит данные из архива
  assert.equal(app.sandbox.localStorage.getItem('masha_promptVersion'), '20');
  const prompt = app.eval('state.prompt');
  assert.match(prompt, /Виктория|Вика/);
  assert.match(prompt, /лошад/, 'в промпте должны быть её внутренние шутки из архива');
  assert.match(prompt, /Ну коть|Ну котик/, 'её реальные фразы из архива');
  assert.match(prompt, /Что делаешь\?/, 'её самый частый вопрос');
  assert.match(prompt, /390|3910|-_—|-_-/, 'её фирменное «-_-»');
  assert.match(prompt, /чо/i);
  assert.match(prompt, /Не начинай с «Конечно»/, 'промпт должен запрещать ассистентские вступления');
  assert.match(prompt, /НЕ перечисляй ничего списком|не перечисляй/i, 'запрет на списки');

  // а вот свой промпт перезаписывать нельзя
  app.sandbox.localStorage.setItem('masha_prompt', 'МОЙ ПРОМПТ');
  app.sandbox.localStorage.setItem('masha_promptCustom', '1');
  app.sandbox.localStorage.setItem('masha_promptVersion', '1');
  const changed = app.call('applyPromptVersion()');
  assert.equal(changed, false);
  assert.equal(app.sandbox.localStorage.getItem('masha_prompt'), 'МОЙ ПРОМПТ');

  await app.call('initiative && initiative.stop()');
});

test('её ответ дробится на серии, а «чё» правится на «чо»', async () => {
  const app = createApp({ fetch: async () => jsonReply('Ты чё там\nЗай, ты чё хотел?') });
  await new Promise(r => setTimeout(r, 60));
  type(app, 'привет');
  await app.call('sendMessage()');

  const her = app.state().messages.filter(m => m.role === 'assistant');
  // серии у неё были в 36% случаев: 1-2 сообщения — норма, лишь бы разбивка не ломала текст
  assert.ok(her.length >= 1 && her.length <= 2, 'серия 1-2 сообщения: ' + her.length);
  const joined = her.map(m => m.content).join(' ');
  assert.ok(joined.includes('Ты чо там'), joined);
  assert.ok(!/чё/i.test(joined), '«чё» должно стать «чо»: ' + joined);

  // проверяем саму правку: по архиву «чё» — 50 из 123 354, «чо» — 506
  assert.equal(app.call('herize', 'Чё делаешь?'), 'Чо делаешь?');
  assert.equal(app.call('herize', 'Ты чё там'), 'Ты чо там');
  assert.equal(app.call('herize', 'Че'), 'Чо');
  assert.equal(app.call('herize', 'М?'), 'А?', '«М?» — не её слово, заменяем на «А?»');
  assert.equal(app.call('breakFillerRun', '-_-', '-_-'), '?', 'две пустышки подряд не повторяем');
  assert.equal(app.call('breakFillerRun', 'Нормально', '-_-'), '-_-', 'если предыдущее не пустышка — не трогаем');
  assert.equal(app.call('herize', 'Почекай'), 'Почекай', 'внутри слов не трогаем');
  assert.equal(app.call('herize', 'человек через'), 'человек через');
  const sp = app.call('splitHerReply', 'Я спать\nУстала, голова болит'); assert.ok(sp.length >= 1 && sp.length <= 2, 'серия 1-2 сообщения: ' + sp.length); assert.ok(sp.join(' ').includes('Устала'));
  await app.call('initiative && initiative.stop()');
});

test('HTML вместо JSON: ошибка в чате, кнопка «Повторить», без alert', async () => {
  const app = createApp({ fetch: async (url) => (String(url).indexOf('archive/') === 0 ? notFound() : htmlReply(200)) });
  await new Promise(r => setTimeout(r, 60));
  type(app, 'привет');
  await app.call('sendMessage()');

  const chat = textOf(app.document.getElementById('chat'));
  assert.match(chat, /не смогла ответить/i, chat.slice(0, 200));
  assert.match(chat, /сайт, а не релей|не JSON|HTML/i);
  assert.doesNotMatch(chat, /Unexpected token/i);
  assert.ok(findButton(app.document.getElementById('chat'), 'Повторить'), 'должна быть кнопка Повторить');
  assert.equal(app.sandbox.__alerts.length, 0);
  assert.equal(app.document.getElementById('input').value, 'привет');
  assert.equal(app.document.getElementById('server-banner').style.display, 'block');
  await app.call('initiative && initiative.stop()');
});

test('офлайн: сообщение в очереди и доставка после возврата связи', async () => {
  const app = createApp({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await new Promise(r => setTimeout(r, 60));
  app.eval('MashaAPI.setEndpoints(["https://relay.test/api/relay"])');
  app.eval('MashaAPI.resetCooldowns()');
  type(app, 'я без связи');
  await app.call('sendMessage()');
  assert.equal(app.state().pending.length, 1);

  app.setFetch(async () => jsonReply('наконец-то'));
  await app.call('flushPending()');
  const st = app.state();
  assert.equal(st.pending.length, 0);
  assert.equal(st.messages[st.messages.length - 1].content, 'наконец-то');
  await app.call('initiative && initiative.stop()');
});

test('архив из IndexedDB уходит в промпт как воспоминания', async () => {
  let payload = null;
  const app = createApp({
    fetch: async (url, options) => {
      if (String(url).indexOf('archive/') === 0) return notFound();
      if (options && options.body) payload = JSON.parse(options.body);
      return jsonReply('ага, помню');
    }
  });
  await new Promise(r => setTimeout(r, 80));
  await app.eval(`(async () => {
    await MashaMemory.open();
    const base = Date.UTC(2024, 7, 18, 15, 0, 0);
    await MashaMemory.db.importMessages([
      { role: 'user', content: 'я психанул из-за игры в бравл старс', ts: base, extId: 'a' },
      { role: 'assistant', content: 'блин, ну ты даешь', ts: base + 60000, extId: 'b' }
    ], { source: 'archive' });
    state.archiveReady = true;
    return MashaMemory.db.count();
  })()`);

  type(app, 'помнишь, как я психанул из-за игры?');
  await app.call('sendMessage()');
  assert.ok(payload, 'запрос должен уйти');
  assert.match(payload.systemPrompt, /ВОСПОМИНАНИЯ|ФРАГМЕНТЫ ИЗ АРХИВА/i);
  assert.match(payload.systemPrompt, /бравл старс|игра/i);
  await app.call('initiative && initiative.stop()');
});

test('на GitHub Pages свой /api/relay не попадает в настройки', async () => {
  const app = createApp({ fetch: async () => notFound() });
  await new Promise(r => setTimeout(r, 60));
  app.sandbox.location.hostname = 'user.github.io';
  app.sandbox.location.origin = 'https://user.github.io';
  app.eval('MashaAPI.loadEndpoints()');
  await app.call('openSettings()');
  await new Promise(r => setTimeout(r, 60));
  const value = app.document.getElementById('endpoints-input').value;
  assert.ok(value.indexOf('github.io') === -1, 'не должно быть github.io: ' + value);
  const stats = app.document.getElementById('memory-stats').innerHTML + app.document.getElementById('memory-stats').textContent;
  assert.ok(stats.length > 0);
  assert.ok(app.document.getElementById('initiative-status').textContent.length > 0);
  await app.call('initiative && initiative.stop()');
});

test('эмоции: сухой ответ её обижает, «прости» — отводит', () => {
  const app = createApp();
  const mood = () => app.state().mood;
  const start = JSON.parse(JSON.stringify(mood()));
  assert.ok(start.нежность > 0, 'в начале она нежная');

  // по данным архива: «.» и «да» — главные триггеры её обиды
  app.call('moodApplyUser', '.');
  assert.ok(mood().обида > start.обида, 'сухой ответ должен поднять обиду');
  app.call('moodApplyUser', 'да');
  const обида = mood().обида;
  assert.ok(обида >= 15, 'накопленная обида: ' + обида);

  // «прости» её отводит (в архиве — сразу «Хорошо»)
  app.call('moodApplyUser', 'прости меня');
  assert.ok(mood().обида < обида, 'прости должно снижать обиду: ' + mood().обида);

  // «люблю» усиливает нежность
  app.call('moodApplyUser', 'я тебя очень сильно люблю');
  assert.ok(mood().нежность > start.нежность, 'любовь должна поднимать нежность');

  // состояние для промпта — человеческое, а не код спрайта
  const hint = app.call('moodHint');
  assert.match(hint, /ты (нежная|обижена|спокойная|радуешься|устала)/i, hint);

  // настроение переживает перезагрузку
  const saved = app.sandbox.localStorage.getItem('masha_mood');
  assert.ok(saved && JSON.parse(saved).нежность >= 0, 'настроение сохраняется');
});

test('память разговоров: помнит, о чём говорили в приложении', () => {
  const app = createApp();
  app.call('rememberChat', 'как дела?', 'Нормально, а ты?');
  app.call('rememberChat', 'что делаешь?', 'Лежу');
  const text = app.call('chatNotesText', 8);
  assert.match(text, /как дела/, text);
  assert.match(text, /Лежу/, text);
  const notes = app.state().chatNotes;
  assert.equal(notes.length, 2);
  // после 30 записей старые вытесняются
  for (let i = 0; i < 40; i++) app.call('rememberChat', 'вопрос ' + i, 'ответ ' + i);
  assert.ok(app.state().chatNotes.length <= 30, 'память не растёт бесконечно');
});

test('промпт получает её настроение и недавний разговор', async () => {
  const app = createApp({ fetch: async () => jsonReply('Хорошо') });
  app.call('moodApplyUser', '.');
  app.call('rememberChat', 'ты где?', 'Дома');
  await app.call('callAI', 'привет');
  const req = app.requests.find(r => r.options && typeof r.options.body === 'string');
  assert.ok(req, 'должен быть запрос к модели: ' + app.requests.length);
  const body = JSON.parse(req.options.body);
  const sysText = body.systemPrompt || (body.messages || []).map(m => m.content).join('\n');
  assert.ok(sysText.includes('Маша'), 'системный промпт на месте');
  assert.ok(!/\{\{STATE\}\}|\{\{RECENT_CHAT\}\}/.test(sysText), 'все подстановки заполнены');
  assert.ok(sysText.includes('ты где'), 'недавний разговор попал в промпт');
  assert.ok(/ты (обижена|нежная|спокойная|устала|радуешься)/i.test(sysText), 'настроение попало в промпт');
});