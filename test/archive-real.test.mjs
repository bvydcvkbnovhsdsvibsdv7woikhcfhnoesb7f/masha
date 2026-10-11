/* Регрессия на настоящем архиве, который лежит в archive/ и уезжает в APK.
   Если файла нет (например, в чистом клоне) — тест пропускается. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MashaMemory = require('../js/memory-db.js');
const MashaSearch = require('../js/search-engine.js');

const ARCHIVE = path.join(ROOT, 'archive', 'masha-archive.json.gz');
const INDEX = path.join(ROOT, 'archive', 'masha-index.json.gz');

function readGz(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

test('настоящий архив: 265 080 сообщений, период два года, каждая запись с id', (t) => {
  if (!fs.existsSync(ARCHIVE)) {
    t.skip('нет ' + ARCHIVE);
    return;
  }
  const archive = readGz(ARCHIVE);
  assert.equal(archive.v, 1);
  assert.equal(archive.count, archive.messages.length);
  assert.equal(archive.messages.length, 265080, 'должно быть 265 080 сообщений');
  assert.deepEqual(archive.sources.slice().sort(), ['chat1.json', 'chat2.json']);

  let withExt = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let chars = 0;
  for (const row of archive.messages) {
    assert.ok(Array.isArray(row) && row.length >= 3, 'запись должна быть массивом');
    assert.ok(row[0] === 'user' || row[0] === 'assistant', 'роль: ' + row[0]);
    if (row[3] !== undefined) withExt++;
    if (row[1] > 0) { if (row[1] < minTs) minTs = row[1]; if (row[1] > maxTs) maxTs = row[1]; }
    chars += String(row[2]).length;
  }
  assert.equal(withExt, archive.messages.length, 'у каждого сообщения должен быть id из Telegram');
  assert.equal(new Date(minTs).getFullYear(), 2024);
  assert.equal(new Date(maxTs).getFullYear(), 2026);
  console.log('    [архив] ' + archive.messages.length.toLocaleString('ru-RU') + ' сообщений, '
    + (chars / 1048576).toFixed(1) + ' МБ текста, период '
    + MashaSearch.formatDate(minTs).slice(0, 10) + ' — ' + MashaSearch.formatDate(maxTs).slice(0, 10));
});

test('настоящий индекс: термы и постинги на месте', (t) => {
  if (!fs.existsSync(INDEX)) {
    t.skip('нет ' + INDEX);
    return;
  }
  const index = readGz(INDEX);
  const terms = Object.keys(index.terms || {});
  assert.ok(terms.length > 10000, 'термов: ' + terms.length);
  let postings = 0;
  for (const term of terms) {
    const ids = index.terms[term];
    assert.ok(Array.isArray(ids) && ids.length > 0, 'пустой постинг у терма ' + term);
    assert.ok(ids.length <= index.maxPostings, 'постинг длиннее лимита у ' + term);
    postings += ids.length;
  }
  assert.ok(postings > 200000, 'постингов: ' + postings);
  console.log('    [индекс] ' + terms.length.toLocaleString('ru-RU') + ' термов, ' + postings.toLocaleString('ru-RU') + ' постингов');
});

test('настоящий архив: первые 30 000 сообщений импортируются и ищутся', async (t) => {
  if (!fs.existsSync(ARCHIVE)) {
    t.skip('нет ' + ARCHIVE);
    return;
  }
  const archive = readGz(ARCHIVE);
  const subset = archive.messages.slice(0, 30000).map((row) => ({
    role: row[0], ts: row[1], content: row[2], extId: row[3] !== undefined ? String(row[3]) : ''
  }));

  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'real_' + Date.now() });
  const t0 = Date.now();
  const stats = await db.importMessages(subset, { source: 'archive' });
  assert.equal(stats.inserted, subset.length);
  assert.equal(await db.count(), subset.length);
  assert.ok(stats.terms > 1000, 'термов: ' + stats.terms);

  // повторный импорт того же куска — ни одного дубля
  const again = await db.importMessages(subset, { source: 'archive' });
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, subset.length);

  const queries = ['привет', 'люблю', 'фото', 'колледж'];
  let found = 0;
  for (const q of queries) {
    const r = await db.recall(q, { episodeLimit: 3, radius: 1 });
    if (r.episodes.length) found++;
    const block = MashaSearch.buildContextBlock(r.episodes, { maxChars: 3000 });
    assert.ok(block.length <= 3000);
  }
  assert.ok(found >= 3, 'из ' + queries.length + ' запросов нашли ' + found);
  console.log('    [импорт] 30 000 сообщений за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с, поиск работает');
});
