/* Telegram-экспорт личного чата: определение «она/он», медиа-заглушки,
   id сообщений (чтобы не терять одинаковые реплики в одну секунду). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const require = createRequire(import.meta.url);
const MashaImport = require('../js/import-manager.js');
const MashaMemory = require('../js/memory-db.js');

/* Маленький, но показательный экспорт: ник «её» менялся, есть медиа,
   сервисные записи, text списком и одинаковые реплики в одну секунду. */
function telegramFixture() {
  return {
    name: '🎰',
    type: 'personal_chat',
    id: 111,
    messages: [
      { id: 1, type: 'message', date: '2024-08-17T19:18:41', date_unixtime: '1723911521', from: 'Маша', from_id: 'user111', text: 'привет' },
      { id: 2, type: 'message', date: '2024-08-17T19:19:00', date_unixtime: '1723911540', from: 'Эдуард', from_id: 'user222', text: 'привет, зая' },
      { id: 3, type: 'service', date: '2024-08-17T19:20:00', date_unixtime: '1723911600', actor: 'Эдуард', actor_id: 'user222', action: 'pin_message', text: '' },
      // ник сменился, id тот же — всё равно «она»
      { id: 4, type: 'message', date: '2024-08-17T19:21:00', date_unixtime: '1723911660', from: '🎰', from_id: 'user111', text: 'ага' },
      { id: 5, type: 'message', date: '2024-08-17T19:22:00', date_unixtime: '1723911720', from: 'Эдуард', from_id: 'user222', file: 'stickers/sticker.webp', media_type: 'sticker', sticker_emoji: '😊', mime_type: 'image/webp' },
      { id: 6, type: 'message', date: '2024-08-17T19:23:00', date_unixtime: '1723911780', from: 'Маша', from_id: 'user111', photo: '(File not included.)' },
      { id: 7, type: 'message', date: '2024-08-17T19:24:00', date_unixtime: '1723911840', from: 'Маша', from_id: 'user111', media_type: 'voice_message', file: 'voice.ogg', mime_type: 'audio/ogg' },
      { id: 8, type: 'message', date: '2024-08-17T19:25:00', date_unixtime: '1723911900', from: 'Эдуард', from_id: 'user222', media_type: 'video_message', file: 'video.mp4', mime_type: 'video/mp4' },
      { id: 9, type: 'message', date: '2024-08-17T19:26:00', date_unixtime: '1723911960', from: 'Эдуард', from_id: 'user222', media_type: 'video_file', file: 'IMG.MP4', mime_type: 'video/mp4' },
      { id: 10, type: 'message', date: '2024-08-17T19:27:00', date_unixtime: '1723912020', from: 'Маша', from_id: 'user111', media_type: 'animation', file: 'g.mp4', mime_type: 'video/mp4' },
      { id: 11, type: 'message', date: '2024-08-17T19:28:00', date_unixtime: '1723912080', from: 'Маша', from_id: 'user111', poll: { question: 'что?' } },
      { id: 12, type: 'message', date: '2024-08-17T19:29:00', date_unixtime: '1723912140', from: 'Эдуард', from_id: 'user222', file: 'doc.pdf', file_name: 'doc.pdf', mime_type: 'application/pdf' },
      { id: 13, type: 'message', date: '2024-08-17T19:30:00', date_unixtime: '1723912200', from: 'Маша', from_id: 'user111', text: ['смотри ', { type: 'bold', text: 'это' }, ' ссылка'] },
      // одинаковые реплики в одну и ту же секунду — должны сохраниться обе
      { id: 14, type: 'message', date: '2024-08-17T19:31:00', date_unixtime: '1723912260', from: 'Маша', from_id: 'user111', text: 'Ну' },
      { id: 15, type: 'message', date: '2024-08-17T19:31:00', date_unixtime: '1723912260', from: 'Маша', from_id: 'user111', text: 'Ну' }
    ]
  };
}

test('Telegram: «она» — собеседник чата, даже если ник менялся', () => {
  const json = telegramFixture();
  assert.equal(MashaImport.detectFormat(json), 'telegram');
  assert.equal(MashaImport.isPersonalChat(json), true);

  const parts = MashaImport.detectParticipants(json);
  assert.equal(parts.length, 2);
  const peer = parts.find(p => p.isPeer);
  const other = parts.find(p => !p.isPeer);
  assert.equal(peer.id, 'user111');
  assert.equal(other.id, 'user222');

  const res = MashaImport.normalizeArchive(json, { source: 'archive' });
  assert.equal(res.format, 'telegram');
  assert.equal(res.ambiguous, false);
  assert.equal(res.peerResolved, true);
  assert.equal(res.serviceSkipped, 1, 'сервисная запись должна быть пропущена');

  // 15 записей: 1 сервисная пропущена + 1 «фото» вместо пустого текста остаются
  const she = res.messages.filter(m => m.role === 'assistant');
  const he = res.messages.filter(m => m.role === 'user');
  assert.ok(she.length >= 6, 'она: ' + she.length);
  assert.ok(he.length >= 5, 'он: ' + he.length);
  assert.equal(she[0].content, 'привет');
  assert.equal(he[0].content, 'привет, зая');
  assert.ok(!res.messages.some(m => m.content === '' && !m.content), 'пустых сообщений быть не должно');
});

test('Telegram: медиа превращаются в понятные заглушки', () => {
  const res = MashaImport.normalizeArchive(telegramFixture(), { source: 'archive' });
  const contents = res.messages.map(m => m.content);
  assert.ok(contents.includes('[стикер 😊]'), contents.join(' | '));
  assert.ok(contents.includes('[фото]'));
  assert.ok(contents.includes('[голосовое]'));
  assert.ok(contents.includes('[кружок]'));
  assert.ok(contents.includes('[видео]'));
  assert.ok(contents.includes('[гифка]'));
  assert.ok(contents.includes('[опрос]'));
  assert.ok(contents.includes('[файл]'));
  assert.ok(contents.includes('смотри это ссылка'), 'text-массив склеивается');
});

test('Telegram: id сообщения сохраняется, даты разобраны', () => {
  const res = MashaImport.normalizeArchive(telegramFixture(), { source: 'archive' });
  const first = res.messages[0];
  assert.equal(first.extId, '1');
  assert.equal(first.ts, 1723911521 * 1000);
  assert.equal(first.iso.slice(0, 10), '2024-08-17');
  assert.equal(first.day, '2024-08-17');
  const sameSecond = res.messages.filter(m => m.content === 'Ну');
  assert.equal(sameSecond.length, 2, 'обе одинаковые реплики должны остаться');
  assert.notEqual(sameSecond[0].extId, sameSecond[1].extId);
});

test('Telegram: без id чата участники неоднозначны, но можно указать «она» вручную', () => {
  const json = telegramFixture();
  delete json.id;                 // нет id собеседника
  json.name = 'Чат';              // имя чата ни на кого не указывает
  // и ники не похожи на известные («Маша»/«Эдуард») — распознать нечем
  json.messages.forEach(m => {
    if (m.from_id === 'user111') m.from = 'X';
    if (m.from_id === 'user222') m.from = 'Y';
  });
  const res = MashaImport.normalizeArchive(json, { source: 'archive' });
  assert.equal(res.ambiguous, true);
  assert.ok(res.warnings.some(w => /кто из участников/i.test(w)), res.warnings.join(' | '));
  assert.equal(res.messages.length, 0, 'без указания «она» сообщения пропускаются');

  const fixed = MashaImport.normalizeArchive(json, { source: 'archive', herName: 'X' });
  assert.equal(fixed.ambiguous, false);
  assert.ok(fixed.messages.length > 10);
  assert.equal(fixed.messages.filter(m => m.role === 'assistant').length, 9, 'она');
  assert.equal(fixed.messages.filter(m => m.role === 'user').length, 5, 'он');
});

test('Telegram: если id нет, но ники узнаваемы (Маша/Эдуард) — роли определяются', () => {
  const json = telegramFixture();
  delete json.id;                 // name остаётся '🎰'
  const res = MashaImport.normalizeArchive(json, { source: 'archive' });
  assert.equal(res.ambiguous, false, 'сообщения распознались — приставать к пользователю не нужно');
  assert.ok(res.messages.length > 10);
  assert.equal(res.messages.filter(m => m.role === 'assistant').length, 9);
  assert.equal(res.messages.filter(m => m.role === 'user').length, 5);
});

test('Telegram: одинаковые реплики в одну секунду не схлопываются, повторный импорт идемпотентен', async () => {
  const res = MashaImport.normalizeArchive(telegramFixture(), { source: 'archive' });
  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'tg_' + Date.now() });

  const first = await db.importMessages(res.messages, { source: 'archive' });
  assert.equal(first.inserted, res.messages.length);
  assert.equal(await db.count(), res.messages.length);

  const stored = await db.getRecent(res.messages.length);
  assert.equal(stored.filter(m => m.content === 'Ну').length, 2, 'обе «Ну» должны лежать в памяти');

  const second = await db.importMessages(res.messages, { source: 'archive' });
  assert.equal(second.inserted, 0, 'повторный импорт ничего не добавляет');
  assert.equal(second.duplicates, res.messages.length);
  assert.equal(await db.count(), res.messages.length);
});

test('Telegram: поиск находит реальный эпизод по редкому слову', async () => {
  const json = telegramFixture();
  json.messages.push({
    id: 100, type: 'message', date: '2025-01-01T12:00:00', date_unixtime: '1735732800',
    from: 'Маша', from_id: 'user111', text: 'я сегодня ела сырники и думала о тебе'
  });
  const res = MashaImport.normalizeArchive(json, { source: 'archive' });
  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'tg2_' + Date.now() });
  await db.importMessages(res.messages, { source: 'archive' });

  const recall = await db.recall('помнишь, я ела сырники?', { episodeLimit: 2, radius: 1 });
  assert.ok(recall.episodes.length > 0);
  const text = recall.episodes.flatMap(e => e.items.map(m => m.content)).join(' ');
  assert.match(text, /сырники/i);
});

test('importFiles: спрашивает «кто она» и импортирует с ответом пользователя', async () => {
  const json = telegramFixture();
  delete json.id;
  json.name = 'Чат';
  json.messages.forEach(m => {
    if (m.from_id === 'user111') m.from = 'X';
    if (m.from_id === 'user222') m.from = 'Y';
  });
  const raw = JSON.stringify(json);
  const file = { name: 'chat.json', size: raw.length, text: async () => raw };

  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'tg3_' + Date.now() });
  const asked = [];
  const stats = await MashaImport.importFiles([file], {
    memory: db,
    source: 'archive',
    chooseHer: async (participants, fileName) => {
      asked.push({ names: participants.map(p => p.name), fileName });
      return 'X';
    }
  });

  assert.equal(asked.length, 1, 'приложение должно спросить один раз');
  assert.deepEqual(asked[0].names.sort(), ['X', 'Y']);
  assert.equal(asked[0].fileName, 'chat.json');
  assert.ok(stats.inserted > 10, 'после ответа сообщения должны импортироваться: ' + stats.inserted);
  assert.equal(await db.count(), stats.inserted);

  const recent = await db.getRecent(stats.inserted);
  assert.equal(recent.filter(m => m.role === 'assistant').length, 9);
  assert.equal(recent.filter(m => m.role === 'user').length, 5);
});

/* Реальные файлы пользователя — если они лежат на месте (в CI их нет). */const REAL = [
  'C:\\Users\\Эдуард\\Downloads\\рпрп\\chat1.json',
  'C:\\Users\\Эдуард\\Downloads\\тма\\chat2.json'
];

test('реальные экспорты Telegram: 265 395 записей, роли определяются', (t) => {
  const missing = REAL.filter(f => !fs.existsSync(f));
  if (missing.length) {
    t.skip('нет файлов: ' + missing.join(', '));
    return;
  }
  let total = 0;
  let she = 0;
  let he = 0;
  for (const file of REAL) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const res = MashaImport.normalizeArchive(json, { source: file });
    assert.equal(res.format, 'telegram');
    assert.equal(res.peerResolved, true, 'собеседник должен определяться автоматически');
    assert.equal(res.ambiguous, false);
    total += res.total;
    she += res.messages.filter(m => m.role === 'assistant').length;
    he += res.messages.filter(m => m.role === 'user').length;
  }
  assert.equal(total, 265395);
  assert.ok(she > 120000 && he > 130000, 'она: ' + she + ', он: ' + he);
  assert.equal(she + he, 265080);
  console.log('    [telegram] реальные файлы: он ' + he + ', она ' + she + ', всего ' + (she + he));
});
