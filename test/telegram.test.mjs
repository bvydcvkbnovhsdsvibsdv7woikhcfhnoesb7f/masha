/* Telegram-экспорт: кто «она», медиа-заглушки, id сообщений, реальные файлы. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const require = createRequire(import.meta.url);
const MashaImport = require('../js/import-manager.js');
const MashaMemory = require('../js/memory-db.js');

function fixture() {
  return {
    name: '🎰',
    type: 'personal_chat',
    id: 111,
    messages: [
      { id: 1, type: 'message', date: '2024-08-17T19:18:41', date_unixtime: '1723911521', from: 'Вика', from_id: 'user111', text: 'привет' },
      { id: 2, type: 'message', date: '2024-08-17T19:19:00', date_unixtime: '1723911540', from: 'Эдуард', from_id: 'user222', text: 'привет, зая' },
      { id: 3, type: 'service', date: '2024-08-17T19:20:00', date_unixtime: '1723911600', actor: 'Эдуард', action: 'pin_message', text: '' },
      { id: 4, type: 'message', date: '2024-08-17T19:21:00', date_unixtime: '1723911660', from: '🎰', from_id: 'user111', text: 'ага' },
      { id: 5, type: 'message', date: '2024-08-17T19:22:00', date_unixtime: '1723911720', from: 'Эдуард', from_id: 'user222', media_type: 'sticker', sticker_emoji: '😊', mime_type: 'image/webp' },
      { id: 6, type: 'message', date: '2024-08-17T19:23:00', date_unixtime: '1723911780', from: 'Вика', from_id: 'user111', photo: '(File not included.)' },
      { id: 7, type: 'message', date: '2024-08-17T19:24:00', date_unixtime: '1723911840', from: 'Вика', from_id: 'user111', media_type: 'voice_message', mime_type: 'audio/ogg' },
      { id: 8, type: 'message', date: '2024-08-17T19:25:00', date_unixtime: '1723911900', from: 'Эдуард', from_id: 'user222', media_type: 'video_message', mime_type: 'video/mp4' },
      { id: 9, type: 'message', date: '2024-08-17T19:26:00', date_unixtime: '1723911960', from: 'Эдуард', from_id: 'user222', media_type: 'animation', mime_type: 'video/mp4' },
      { id: 10, type: 'message', date: '2024-08-17T19:27:00', date_unixtime: '1723912020', from: 'Вика', from_id: 'user111', poll: { question: 'что?' } },
      { id: 11, type: 'message', date: '2024-08-17T19:28:00', date_unixtime: '1723912080', from: 'Вика', from_id: 'user111', text: ['смотри ', { type: 'bold', text: 'это' }] },
      { id: 12, type: 'message', date: '2024-08-17T19:31:00', date_unixtime: '1723912260', from: 'Вика', from_id: 'user111', text: 'Ну' },
      { id: 13, type: 'message', date: '2024-08-17T19:31:00', date_unixtime: '1723912260', from: 'Вика', from_id: 'user111', text: 'Ну' }
    ]
  };
}

test('«она» — собеседник чата, даже когда ник меняется', () => {
  const json = fixture();
  assert.equal(MashaImport.detectFormat(json), 'telegram');
  assert.equal(MashaImport.isPersonalChat(json), true);

  const parts = MashaImport.detectParticipants(json);
  const peer = parts.find(p => p.isPeer);
  assert.equal(peer.id, 'user111');

  const res = MashaImport.normalizeArchive(json, { source: 'archive' });
  assert.equal(res.format, 'telegram');
  assert.equal(res.peerResolved, true);
  assert.equal(res.ambiguous, false);
  assert.equal(res.serviceSkipped, 1);

  const she = res.messages.filter(m => m.role === 'assistant');
  const he = res.messages.filter(m => m.role === 'user');
  assert.equal(she.length, 8, 'она: ' + she.length);
  assert.equal(he.length, 4, 'он: ' + he.length);
  assert.equal(she[0].content, 'привет');
  assert.equal(he[0].content, 'привет, зая');
});

test('медиа превращаются в понятные заглушки', () => {
  const res = MashaImport.normalizeArchive(fixture(), { source: 'archive' });
  const c = res.messages.map(m => m.content);
  for (const expected of ['[стикер 😊]', '[фото]', '[голосовое]', '[кружок]', '[гифка]', '[опрос]', 'смотри это']) {
    assert.ok(c.includes(expected), 'нет ' + expected + ' в ' + JSON.stringify(c));
  }
});

test('id сообщения сохраняется, даты разобраны, одинаковые реплики не схлопываются', async () => {
  const res = MashaImport.normalizeArchive(fixture(), { source: 'archive' });
  const first = res.messages[0];
  assert.equal(first.extId, '1');
  assert.equal(first.ts, 1723911521 * 1000);
  assert.equal(first.day, '2024-08-17');

  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'tg_' + Date.now() });
  const stats = await db.importMessages(res.messages, { source: 'archive' });
  assert.equal(stats.inserted, res.messages.length);
  const recent = await db.getRecent(res.messages.length);
  assert.equal(recent.filter(m => m.content === 'Ну').length, 2, 'обе «Ну» должны остаться');

  const again = await db.importMessages(res.messages, { source: 'archive' });
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, res.messages.length);
});

test('если роли не определить — сообщения пропускаются, но можно указать «она»', () => {
  const json = fixture();
  delete json.id;
  json.name = 'Чат';
  json.messages.forEach(m => {
    if (m.from_id === 'user111') m.from = 'X';
    if (m.from_id === 'user222') m.from = 'Y';
  });
  const bad = MashaImport.normalizeArchive(json, { source: 'archive' });
  assert.equal(bad.ambiguous, true);
  assert.equal(bad.messages.length, 0);
  assert.ok(bad.warnings.some(w => /кто из участников/i.test(w)));

  const good = MashaImport.normalizeArchive(json, { source: 'archive', herName: 'X' });
  assert.equal(good.ambiguous, false);
  assert.equal(good.messages.filter(m => m.role === 'assistant').length, 8);
  assert.equal(good.messages.filter(m => m.role === 'user').length, 4);
});

test('importFiles спрашивает «кто она» и импортирует с ответом', async () => {
  const json = fixture();
  delete json.id;
  json.name = 'Чат';
  json.messages.forEach(m => {
    if (m.from_id === 'user111') m.from = 'X';
    if (m.from_id === 'user222') m.from = 'Y';
  });
  const raw = JSON.stringify(json);
  const file = { name: 'chat.json', size: raw.length, text: async () => raw };
  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'tg2_' + Date.now() });
  let asked = 0;
  const stats = await MashaImport.importFiles([file], {
    memory: db, source: 'archive',
    chooseHer: async (participants) => { asked++; return 'X'; }
  });
  assert.equal(asked, 1);
  assert.equal(stats.inserted, 12);
  const recent = await db.getRecent(12);
  assert.equal(recent.filter(m => m.role === 'assistant').length, 8);
});

/* Реальные файлы пользователя (в чистом клоне их нет) */
const REAL = [
  'C:\\Users\\Эдуард\\Downloads\\рпрп\\chat1.json',
  'C:\\Users\\Эдуард\\Downloads\\тма\\chat2.json',
  'C:\\Users\\Эдуард\\Downloads\\chat1.json',
  'C:\\Users\\Эдуард\\Downloads\\chat2.json'
].filter(f => fs.existsSync(f));

test('реальные экспорты: 265 395 записей, роли определяются автоматически', (t) => {
  const missing = REAL.filter(f => !fs.existsSync(f));
  if (missing.length) { t.skip('нет файлов: ' + missing.join(', ')); return; }
  let total = 0, she = 0, he = 0;
  for (const file of REAL) {
    const res = MashaImport.normalizeArchive(JSON.parse(fs.readFileSync(file, 'utf8')), { source: file });
    assert.equal(res.format, 'telegram');
    assert.equal(res.peerResolved, true);
    assert.equal(res.ambiguous, false);
    total += res.total;
    she += res.messages.filter(m => m.role === 'assistant').length;
    he += res.messages.filter(m => m.role === 'user').length;
  }
  assert.equal(total, 265395);
  assert.equal(she, 126895);
  assert.equal(he, 138185);
  console.log('    [telegram] он ' + he.toLocaleString('ru-RU') + ', она ' + she.toLocaleString('ru-RU'));
});
