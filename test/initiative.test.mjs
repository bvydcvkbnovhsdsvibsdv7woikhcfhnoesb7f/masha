/* Тесты MashaInitiative (js/initiative.js) — «Маша пишет первой».
   Проверяем расписание по Красноярску (UTC+7), сон, поводы, кап на день,
   откат при игноре, уведомления и то, что слабый повод не дёргает API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MashaInitiative = require('../js/initiative.js');

const HOUR = 3600 * 1000;

/* Красноярск = UTC+7 круглый год (перехода на летнее время нет). */
function krat(utcHour, day = 10, month = 5) {
  return Date.UTC(2024, month - 1, day, utcHour, 0, 0);
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); }
  };
}

function baseState(over) {
  return Object.assign({
    userStatus: 'awake',
    lastUserMessageTime: 0,
    lastMashaMessageTime: 0,
    currentState: 'calm',
    events: [],
    lastThought: '',
    messages: [],
    relationship: 80
  }, over || {});
}

function makeInstance(opts) {
  opts = opts || {};
  const storage = opts.storage || makeStorage();
  const sent = [];
  const thoughts = [];
  const skips = [];
  let apiCalls = 0;
  const api = opts.api || {
    initiative: async () => { apiCalls++; return { ok: true, initiative: true, text: 'привет, ты тут?' }; }
  };
  const inst = MashaInitiative.create({
    config: Object.assign({ tz: 'Asia/Krasnoyarsk' }, opts.config || {}),
    now: () => opts.now,
    random: () => (opts.random === undefined ? 0 : opts.random),
    getState: () => opts.state,
    onMessage: (t, m) => sent.push({ text: t, meta: m }),
    onThought: r => thoughts.push(r),
    onSkip: r => skips.push(r),
    api,
    storage,
    document: { hidden: !!opts.hidden }
  });
  return { inst, sent, thoughts, skips, storage, apiCallCount: () => apiCalls };
}

test('он спит — не пишем', () => {
  const now = krat(3, 10);            // 10:00 по Красноярску
  const { inst } = makeInstance({ now, state: baseState({ userStatus: 'sleeping' }) });
  const d = inst.shouldAttempt(baseState({ userStatus: 'sleeping' }), now);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'он спит');
});

test('ночь (02:00 по Красноярску) — не пишем, даже если давно молчит', () => {
  const now = krat(19, 9);            // 02:00 следующего дня по Красноярску
  const st = baseState({ lastUserMessageTime: now - 12 * HOUR });
  const { inst } = makeInstance({ now, state: st });
  const d = inst.shouldAttempt(st, now);
  assert.equal(d.ok, false);
  assert.match(d.reason, /ночь/);
});

test('утро: молчит 9 часов, 10:00 — сильный повод', () => {
  const now = krat(3, 10);            // 10:00 KRAT
  const st = baseState({ lastUserMessageTime: now - 9 * HOUR, lastMashaMessageTime: now - 12 * HOUR });
  const { inst } = makeInstance({ now, state: st });
  const d = inst.shouldAttempt(st, now);
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'утро');
  assert.equal(d.urgency, 0.95);
});

test('вечер: молчит 4 часа, 20:00 — повод есть', () => {
  const now = krat(13, 10);           // 20:00 KRAT
  const st = baseState({ lastUserMessageTime: now - 4 * HOUR, lastMashaMessageTime: now - 5 * HOUR });
  const { inst } = makeInstance({ now, state: st });
  const d = inst.shouldAttempt(st, now);
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'вечер');
});

test('только что общались (5 минут) — не пишем', () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 5 * 60 * 1000, lastMashaMessageTime: now - 2 * HOUR });
  const { inst } = makeInstance({ now, state: st });
  assert.equal(inst.shouldAttempt(st, now).ok, false);
  assert.match(inst.shouldAttempt(st, now).reason, /только что/);
});

test('она недавно писала (10 минут) — не повторяемся', () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 3 * HOUR, lastMashaMessageTime: now - 10 * 60 * 1000 });
  const { inst } = makeInstance({ now, state: st });
  assert.equal(inst.shouldAttempt(st, now).ok, false);
  assert.match(inst.shouldAttempt(st, now).reason, /недавно писала/);
});

test('праздник: сегодня его ДР — максимальный приоритет', () => {
  const now = krat(6, 1, 10);         // 1 октября, 13:00 KRAT
  const st = baseState({
    lastUserMessageTime: now - 3 * HOUR,
    lastMashaMessageTime: now - 5 * HOUR,
    events: [{ name: 'Его ДР', month: 10, day: 1 }]
  });
  const { inst } = makeInstance({ now, state: st });
  const d = inst.shouldAttempt(st, now);
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'праздник');
  assert.equal(d.urgency, 1);
});

test('кап на день: 6 инициатив — молчим до следующих суток', () => {
  const now = krat(13, 10);
  const storage = makeStorage();
  const log = [];
  for (let i = 0; i < 6; i++) log.push(now - i * HOUR);
  storage.setItem('masha_initiative_log', JSON.stringify(log));
  const st = baseState({ lastUserMessageTime: now - 4 * HOUR, lastMashaMessageTime: now - 5 * HOUR });
  const { inst } = makeInstance({ now, state: st, storage });
  const d = inst.shouldAttempt(st, now);
  assert.equal(d.ok, false);
  assert.match(d.reason, /хватит/);
});

test('он не отвечает на 3 её сообщения — откат на 4 часа', () => {
  const now = krat(13, 10);
  const lastUser = now - 6 * HOUR;
  const storage = makeStorage();
  storage.setItem('masha_initiative_log', JSON.stringify([
    lastUser + HOUR, lastUser + 2 * HOUR, lastUser + 3 * HOUR
  ]));
  const st = baseState({ lastUserMessageTime: lastUser, lastMashaMessageTime: lastUser + 3 * HOUR });
  const { inst } = makeInstance({ now, state: st, storage });
  const d = inst.shouldAttempt(st, now);
  assert.equal(d.ok, false);
  assert.match(d.reason, /не отвечает/);
});

test('tick: она решила написать — сообщение уходит в чат, лог растёт', async () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 4 * HOUR, lastMashaMessageTime: now - 5 * HOUR });
  const { inst, sent, storage } = makeInstance({ now, state: st });
  const res = await inst.tick(false);
  assert.equal(res.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'привет, ты тут?');
  assert.equal(sent[0].meta.trigger, 'вечер');
  const log = JSON.parse(storage.getItem('masha_initiative_log'));
  assert.equal(log.length, 1);
});

test('tick: решила промолчать — причина сохраняется как её мысль', async () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 4 * HOUR, lastMashaMessageTime: now - 5 * HOUR });
  const { inst, sent, thoughts } = makeInstance({
    now, state: st,
    api: { initiative: async () => ({ ok: true, initiative: false, reason: 'нет настроения' }) }
  });
  const res = await inst.tick(false);
  assert.equal(res.sent, false);
  assert.equal(sent.length, 0);
  assert.equal(thoughts[0], 'нет настроения');
});

test('tick: сервер упал — не падаем, записываем мысль об ошибке', async () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 4 * HOUR, lastMashaMessageTime: now - 5 * HOUR });
  const { inst, thoughts } = makeInstance({
    now, state: st,
    api: { initiative: async () => { const e = new Error('boom'); e.friendly = 'нет интернета'; throw e; } }
  });
  const res = await inst.tick(false);
  assert.equal(res.sent, false);
  assert.equal(res.error, true);
  assert.match(thoughts[0], /нет интернета/);
});

test('слабый повод — API не дёргается', async () => {
  const now = krat(8, 10);            // 15:00 KRAT, молчит 2.5 часа — просто «скучаю»
  const st = baseState({ lastUserMessageTime: now - 2.5 * HOUR, lastMashaMessageTime: now - 3 * HOUR });
  const { inst, apiCallCount } = makeInstance({ now, state: st, random: 0.99 });
  const res = await inst.tick(false);
  assert.equal(res.sent, false);
  assert.match(res.reason, /повод слабый/);
  assert.equal(apiCallCount(), 0);
});

test('force (кнопка в настройках) — проверяет даже слабый повод', async () => {
  const now = krat(8, 10);
  const st = baseState({ lastUserMessageTime: now - 2 * HOUR, lastMashaMessageTime: now - 3 * HOUR });
  const { inst, sent, apiCallCount } = makeInstance({ now, state: st, random: 0.99 });
  const res = await inst.tick(true);
  assert.equal(res.sent, true);
  assert.equal(apiCallCount(), 1);
  assert.equal(sent.length, 1);
});

test('status(): видно, почему молчит и сколько ещё ждать', () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 10 * 60 * 1000, lastMashaMessageTime: now - 20 * 60 * 1000 });
  const { inst } = makeInstance({ now, state: st });
  const s = inst.status();
  assert.equal(s.allowed, false);
  assert.equal(s.dailyMax, 6);
  assert.ok(s.nextAllowedInMs >= 0);
  assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
});

test('уведомление, когда приложение свёрнуто', async () => {
  const now = krat(13, 10);
  const st = baseState({ lastUserMessageTime: now - 4 * HOUR, lastMashaMessageTime: now - 5 * HOUR });

  const calls = [];
  let patched = false;
  try {
    Object.defineProperty(globalThis, 'Notification', {
      value: function (title, options) { calls.push({ title, options }); },
      configurable: true
    });
    globalThis.Notification.permission = 'granted';
    patched = true;
  } catch (e) { patched = false; }
  if (!patched) return;

  const { inst } = makeInstance({ now, state: st, hidden: true });
  await inst.tick(false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Маша');
  assert.equal(calls[0].options.body, 'привет, ты тут?');
  delete globalThis.Notification;
});
