/* Сквозной тест: архив -> IndexedDB -> поиск по ключевым словам -> блок
   контекста для промпта. Плюс тест на реальном экспорте переписки и
   проверка масштаба (десятки тысяч сообщений без квадратичного тормоза). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const require = createRequire(import.meta.url);
const MashaImport = require('../js/import-manager.js');
const MashaMemory = require('../js/memory-db.js');
const MashaSearch = require('../js/search-engine.js');

let counter = 0;
function newDb() {
  counter++;
  return MashaMemory.create({
    indexedDB: new FakeIndexedDB(),
    IDBKeyRange,
    name: 'masha_e2e_' + counter + '_' + Date.now()
  });
}

const REAL_EXPORT = 'C:\\Users\\Эдуард\\Downloads\\chat-export-1791699861271.json';

/* Небольшая «переписка за два года» с узнаваемыми эпизодами. */
function coupleArchive() {
  const msgs = [];
  const base = Date.UTC(2024, 7, 18, 15, 0, 0); // 18.08.2024
  const script = [
    ['user', 'привет, как ты'],
    ['assistant', 'привет мальчик мой любимый'],
    ['user', 'я сегодня поссорился с другом из-за игры'],
    ['assistant', 'блин, из-за какой игры? расскажи'],
    ['user', 'да в бравл старс проиграли, я психанул'],
    ['assistant', 'ну ты даешь, это же просто игра'],
    ['user', 'у меня завтра экзамен по математике'],
    ['assistant', 'о блин, готовился хоть?'],
    ['user', 'почти нет, буду ночью учить'],
    ['assistant', 'дурак, ложись спать лучше'],
    ['user', 'а помнишь как мы познакомились'],
    ['assistant', 'конечно помню, ты мне написал первым'],
    ['user', 'у кота опять что-то с лапой'],
    ['assistant', 'бедный коть, к ветеринару надо'],
    ['user', 'скучаю по тебе сильно'],
    ['assistant', 'и я скучаю, муууууж']
  ];
  for (let round = 0; round < 30; round++) {
    script.forEach((pair, i) => {
      msgs.push({
        role: pair[0],
        content: pair[1],
        ts: base + round * 24 * 3600 * 1000 + i * 60000
      });
    });
  }
  return msgs;
}

test('e2e: архив -> память -> поиск находит нужный эпизод', async () => {
  const db = newDb();
  const stats = await db.importMessages(coupleArchive(), { source: 'archive' });
  assert.equal(stats.inserted, 30 * 16);
  assert.equal(await db.count(), 30 * 16);

  const recall = await db.recall('помнишь, мы поссорились из-за игры?', { episodeLimit: 3, radius: 1 });
  assert.ok(recall.episodes.length > 0, 'эпизоды должны найтись');
  const all = recall.episodes.flatMap(e => e.items.map(m => m.content)).join('\n');
  assert.match(all, /поссорился с другом из-за игры/);
  assert.ok(recall.tookMs < 2000, 'поиск должен быть быстрым');

  const block = MashaSearch.buildContextBlock(recall.episodes, { maxChars: 1200 });
  assert.ok(block.length > 0);
  assert.ok(block.length <= 1200, 'блок контекста не должен превышать maxChars');
  assert.match(block, /поссорил|игр/i);
  assert.match(block, /он:|она:/);
});

test('e2e: морфология — «экзамены» находит «экзамен»', async () => {
  const db = newDb();
  await db.importMessages(coupleArchive().slice(0, 16), { source: 'archive' });
  const recall = await db.recall('как прошли экзамены?', { episodeLimit: 2 });
  const all = recall.episodes.flatMap(e => e.items.map(m => m.content)).join('\n');
  assert.match(all, /экзамен/i);
});

test('e2e: повторный импорт того же файла ничего не дублирует', async () => {
  const db = newDb();
  const data = coupleArchive();
  const first = await db.importMessages(data, { source: 'archive' });
  const before = await db.count();
  const second = await db.importMessages(data, { source: 'archive' });
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, first.inserted);
  assert.equal(await db.count(), before);
});

test('e2e: реальный экспорт переписки (924 сообщения) импортируется и ищется', async (t) => {
  if (!fs.existsSync(REAL_EXPORT)) {
    t.skip('нет файла ' + REAL_EXPORT);
    return;
  }
  const json = JSON.parse(fs.readFileSync(REAL_EXPORT, 'utf8'));
  const norm = MashaImport.normalizeArchive(json, { source: 'archive' });
  assert.equal(norm.format, 'qwen');
  assert.equal(norm.total, 924);
  assert.equal(norm.messages.filter(m => m.role === 'user').length, 462);

  const db = newDb();
  const stats = await db.importMessages(norm.messages, { source: 'archive' });
  assert.equal(stats.inserted, norm.messages.length);
  assert.equal(stats.duplicates, 0);
  assert.ok(stats.terms > 100, 'должен построиться индекс ключевых слов');

  const st = await db.getStats();
  assert.equal(st.messages, norm.messages.length);
  assert.ok(st.terms > 100);

  const recall = await db.recall('архив сообщений и память приложения', { episodeLimit: 4 });
  const block = MashaSearch.buildContextBlock(recall.episodes, { maxChars: 2500 });
  assert.ok(block.length <= 2500);
  console.log('    [e2e] реальный экспорт: ' + stats.inserted + ' сообщений, индекс ' + stats.terms
    + ' термов, поиск ' + recall.tookMs + ' мс, фрагментов ' + recall.episodes.length);
});

test('rebuildIndex: пересобирает индекс с нуля, не трогая сообщения', async () => {
  const db = newDb();
  const msgs = coupleArchive();
  const stats = await db.importMessages(msgs, { source: 'archive', buildIndex: false });
  assert.equal(stats.inserted, msgs.length);

  // без индекса поиск ничего не находит
  const before = await db.recall('экзамен по математике', { episodeLimit: 3 });
  assert.equal(before.episodes.length, 0);

  const progress = [];
  const rebuilt = await db.rebuildIndex((done, total) => progress.push([done, total]));
  assert.ok(rebuilt.terms > 0, 'индекс должен наполниться');
  assert.ok(rebuilt.messages >= msgs.length - 5, 'должны пройтись по всем сообщениям');
  assert.ok(progress.length > 0);
  assert.equal(await db.count(), msgs.length, 'сообщения не должны пострадать');

  const after = await db.recall('экзамен по математике', { episodeLimit: 3 });
  assert.ok(after.episodes.length > 0, 'после пересборки поиск снова работает');
  const text = after.episodes.flatMap(e => e.items.map(m => m.content)).join('\n');
  assert.match(text, /экзамен/i);

  const st = await db.getStats();
  assert.ok(st.terms > 0);
});

test('rebuildIndex: повторная пересборка не удваивает постинги', async () => {
  const db = newDb();
  await db.importMessages(coupleArchive(), { source: 'archive' });
  const first = await db.rebuildIndex();
  const second = await db.rebuildIndex();
  assert.equal(second.terms, first.terms);
  const recall = await db.recall('поссорились из-за игры', { episodeLimit: 2 });
  assert.ok(recall.episodes.length > 0);
});

test('готовый индекс из CLI: сообщения + loadIndex дают рабочий поиск', async () => {
  const json = fs.existsSync(REAL_EXPORT) ? JSON.parse(fs.readFileSync(REAL_EXPORT, 'utf8')) : null;
  const source = json
    ? MashaImport.normalizeArchive(json, { source: 'real' }).messages
    : coupleArchive();

  // ровно то, что делает tools/build-archive.mjs
  const archive = MashaImport.buildArchive(source, { sources: ['test'] });
  const index = MashaImport.buildIndex(archive.messages, { maxPostings: 1500 });
  assert.ok(Array.isArray(archive.messages) && archive.messages.length === source.length);
  assert.ok(index.terms && Object.keys(index.terms).length > 50);

  const db = newDb();
  const stats = await db.importMessages(source, { source: 'bundle', buildIndex: false });
  assert.equal(stats.inserted, source.length);
  assert.equal(await db.count(), source.length);

  const progress = [];
  const loaded = await db.loadIndex(index, { onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(loaded.terms, Object.keys(index.terms).length);
  assert.ok(loaded.postings > 0);
  assert.ok(progress.length > 0);

  const st = await db.getStats();
  assert.equal(st.terms, loaded.terms, 'в базе должно быть столько же термов, сколько в индексе');

  const query = json ? 'память и архив сообщений' : 'экзамен по математике';
  const recall = await db.recall(query, { episodeLimit: 4 });
  assert.ok(recall.episodes.length > 0, 'поиск по загруженному индексу должен работать');
});

test('масштаб: 20 000 сообщений — импорт и поиск без квадратичного тормоза', async () => {  const db = newDb();
  const roles = ['user', 'assistant'];
  const N = 20000;
  const msgs = new Array(N);
  for (let i = 0; i < N; i++) {
    const content = (i % 500 === 0)
      ? ('у меня завтра экзамен номер ' + i + ' и я нервничаю')
      : ('обычное сообщение номер ' + i + ' про всякую ерунду и дела');
    msgs[i] = { role: roles[i % 2], content, ts: 1700000000000 + i * 60000 };
  }

  const t0 = Date.now();
  const stats = await db.importMessages(msgs, { source: 'archive', batchSize: 500, indexBatch: 5000 });
  const importMs = Date.now() - t0;
  assert.equal(stats.inserted, N);
  assert.equal(await db.count(), N);

  const t1 = Date.now();
  const recall = await db.recall('у меня завтра экзамен, что делать?', { episodeLimit: 5, radius: 2 });
  const recallMs = Date.now() - t1;
  assert.ok(recall.episodes.length > 0);
  const block = MashaSearch.buildContextBlock(recall.episodes, { maxChars: 3000 });
  assert.ok(block.length > 0 && block.length <= 3000);

  console.log('    [масштаб] ' + N + ' сообщений: импорт ' + importMs + ' мс, поиск ' + recallMs + ' мс, термов ' + stats.terms);
  assert.ok(importMs < 120000, 'импорт 20к сообщений не должен занимать больше 2 минут');
  assert.ok(recallMs < 3000, 'поиск по 20к сообщений должен укладываться в 3 секунды');
});
