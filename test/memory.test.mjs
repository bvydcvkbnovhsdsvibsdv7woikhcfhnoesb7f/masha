/* Память: импорт 265к-подобного архива, дедупликация, поиск, пересборка индекса. */
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
const MashaImport = require('../js/import-manager.js');

const ARCHIVE = path.join(ROOT, 'archive', 'masha-archive.json.gz');
const INDEX = path.join(ROOT, 'archive', 'masha-index.json.gz');

let n = 0;
function newDb() {
  n++;
  return MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'mem_test_' + n + '_' + Date.now() });
}

function couple() {
  const out = [];
  const base = Date.UTC(2024, 7, 18, 15, 0, 0);
  const script = [
    ['user', 'привет, как ты'],
    ['assistant', 'привет, мальчик мой любимый'],
    ['user', 'я сегодня поссорился с другом из-за игры в бравл старс'],
    ['assistant', 'блин, ну ты даешь, это же просто игра'],
    ['user', 'у меня завтра экзамен по математике'],
    ['assistant', 'о блин, готовился хоть?'],
    ['user', 'а помнишь как мы познакомились'],
    ['assistant', 'конечно помню, ты мне написал первым'],
    ['user', 'я сырники хочу'],
    ['assistant', 'и я, пошли есть'],
    ['user', 'у кота опять что-то с лапой'],
    ['assistant', 'бедный коть, к ветеринару надо']
  ];
  for (let r = 0; r < 20; r++) {
    script.forEach((p, i) => out.push({ role: p[0], content: p[1], ts: base + r * 86400000 + i * 60000, extId: 'm' + r + '_' + i }));
  }
  return out;
}

test('импорт, поиск по редкому слову и соседи по эпизоду', async () => {
  const db = newDb();
  const stats = await db.importMessages(couple(), { source: 'archive' });
  assert.equal(stats.inserted, 240);
  assert.equal(await db.count(), 240);
  assert.ok(stats.terms > 20, 'термов: ' + stats.terms);

  const recall = await db.recall('помнишь, как мы поссорились из-за игры?', { episodeLimit: 3 });
  assert.ok(recall.episodes.length > 0);
  const text = recall.episodes.flatMap(e => e.items.map(m => m.content)).join('\n');
  assert.match(text, /поссорился|игр/i);

  const block = MashaSearch.buildContextBlock(recall.episodes, { maxChars: 1200 });
  assert.ok(block.length > 0 && block.length <= 1200);
  assert.match(block, /он:|она:/);
});

test('одинаковые реплики в одну секунду сохраняются обе, повторный импорт идемпотентен', async () => {
  const db = newDb();
  const msgs = [
    { role: 'assistant', content: 'Ну', ts: 1723912260000, extId: '14' },
    { role: 'assistant', content: 'Ну', ts: 1723912260000, extId: '15' },
    { role: 'user', content: 'ну', ts: 1723912260000, extId: '16' }
  ];
  const first = await db.importMessages(msgs, { source: 'archive' });
  assert.equal(first.inserted, 3, 'должны сохраниться все три');
  const second = await db.importMessages(msgs, { source: 'archive' });
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  assert.equal(await db.count(), 3);
});

test('append: живые сообщения попадают в память и находятся', async () => {
  const db = newDb();
  await db.append({ role: 'user', content: 'я купил билеты на квадроцикл', ts: Date.now() });
  await db.append({ role: 'assistant', content: 'ура, наконец то', ts: Date.now() });
  assert.equal(await db.count(), 2);
  const recall = await db.recall('квадроцикл билеты', { episodeLimit: 2 });
  const text = recall.episodes.flatMap(e => e.items.map(m => m.content)).join(' ');
  assert.match(text, /квадроцикл/i);
});

test('rebuildIndex пересобирает индекс, не трогая сообщения', async () => {
  const db = newDb();
  await db.importMessages(couple(), { source: 'archive', buildIndex: false });
  assert.equal((await db.recall('сырники', { episodeLimit: 2 })).episodes.length, 0);
  const rebuilt = await db.rebuildIndex();
  assert.ok(rebuilt.terms > 0, 'термов: ' + rebuilt.terms);
  assert.equal(await db.count(), 240);
  const recall = await db.recall('сырники', { episodeLimit: 2 });
  assert.ok(recall.episodes.length > 0);
});

test('getStats, getRecent и clear', async () => {
  const db = newDb();
  await db.importMessages(couple(), { source: 'archive' });
  const st = await db.getStats();
  assert.equal(st.messages, 240);
  assert.ok(st.terms > 20);
  assert.ok(st.oldest > 0 && st.newest > st.oldest);
  const recent = await db.getRecent(5);
  assert.equal(recent.length, 5);
  assert.ok(recent[0].ts <= recent[4].ts, 'должны идти по времени');
  await db.clear();
  assert.equal(await db.count(), 0);
});

test('sample: случайные живые воспоминания (для вопроса «что ты помнишь?»)', async () => {
  const db = newDb();
  const msgs = couple();
  await db.importMessages(msgs, { source: 'archive' });
  const picked = await db.sample(5);
  assert.equal(picked.length, 5, 'должно вернуться 5 сообщений');
  for (const m of picked) {
    assert.ok(typeof m.content === 'string' && m.content.length >= 12, 'мусор не берём: ' + m.content);
    assert.ok(!m.content.startsWith('['), 'заглушки вроде [фото] не берём');
    assert.ok(m.ts > 0);
  }
  assert.ok(picked[0].ts <= picked[picked.length - 1].ts, 'отсортированы по времени');
  const seqs = new Set(picked.map(m => m.seq));
  assert.equal(seqs.size, picked.length, 'без повторов');

  const block = MashaSearch.buildContextBlock(
    picked.map(m => ({ seq: m.seq, ts: m.ts, items: [m] })), { maxChars: 3000 });
  assert.ok(block.length > 0);
  assert.match(block, /он:|она:/);

  // на пустой базе — пустой массив, а не ошибка
  const empty = newDb();
  await empty.open();
  assert.deepEqual(await empty.sample(3), []);
});

test('чужой стемминг в индексе: память всё равно находит («поссорились» ↔ «поссорили»)', async () => {
  const db = newDb();
  const msgs = couple();
  await db.importMessages(msgs, { source: 'archive', buildIndex: false });

  // Собираем индекс «старой» версией алгоритма: единственный проход усечения.
  // Именно так был собран первый боевой индекс — и половина вопросов не находилась.
  const onePass = (word) => {
    const w = word.toLowerCase().replace(/ё/g, 'е');
    if (w.length < 4) return w;
    for (const end of MashaSearch.ENDINGS) {
      if (w.length - end.length >= 4 && w.slice(-end.length) === end) return w.slice(0, w.length - end.length);
    }
    return w;
  };
  const oldIndex = { v: 1, maxPostings: 1500, terms: {} };
  const rows = couple();
  for (let i = 0; i < rows.length; i++) {
    const seq = i + 1;
    for (const kw of MashaSearch.extractKeywords(rows[i].content)) {
      const key = onePass(kw);
      if (!oldIndex.terms[key]) oldIndex.terms[key] = [];
      if (oldIndex.terms[key].length < 1500) oldIndex.terms[key].push(seq);
    }
  }
  await db.loadIndex(oldIndex);
  const st = await db.getStats();
  assert.equal(st.terms, Object.keys(oldIndex.terms).length);

  for (const q of ['помнишь, как мы поссорились из-за игры', 'как мы познакомились', 'сырники хочу', 'готовился к экзамену']) {
    const recall = await db.recall(q, { episodeLimit: 3 });
    assert.ok(recall.episodes.length > 0, 'не нашлось по запросу: ' + q);
  }
});

test('termVariants: варианты основы перекрывают разные версии алгоритма', () => {
  const v = MashaSearch.termVariants('поссорились');
  assert.ok(v.includes('поссорили'), 'должен быть вариант «поссорили»: ' + JSON.stringify(v));
  assert.ok(v.includes('поссор') || v.includes('поссори'), 'должна быть и глубокая основа: ' + JSON.stringify(v));
  assert.deepEqual(MashaSearch.termVariants('дом'), [], 'короткие слова не трогаем');
});

test('масштаб: 20 000 сообщений импортируются и ищутся без тормозов', async () => {
  const db = newDb();
  const N = 20000;
  const msgs = new Array(N);
  for (let i = 0; i < N; i++) {
    msgs[i] = {
      role: i % 2 ? 'assistant' : 'user',
      content: i % 500 === 0 ? ('у меня завтра экзамен номер ' + i) : ('обычное сообщение номер ' + i + ' про дела'),
      ts: 1700000000000 + i * 60000,
      extId: 'x' + i
    };
  }
  const t0 = Date.now();
  const stats = await db.importMessages(msgs, { source: 'archive' });
  const importMs = Date.now() - t0;
  assert.equal(stats.inserted, N);
  const t1 = Date.now();
  const recall = await db.recall('завтра экзамен, что делать', { episodeLimit: 3 });
  const recallMs = Date.now() - t1;
  assert.ok(recall.episodes.length > 0);
  console.log('    [масштаб] ' + N + ' сообщений: импорт ' + importMs + ' мс, поиск ' + recallMs + ' мс');
  assert.ok(importMs < 120000);
  assert.ok(recallMs < 3000);
});

test('настоящий архив: 265 080 сообщений, индекс соответствует своим сообщениям', async (t) => {
  if (!fs.existsSync(ARCHIVE)) { t.skip('нет ' + ARCHIVE); return; }
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(ARCHIVE)).toString('utf8'));
  assert.equal(archive.count, 265080);
  assert.equal(archive.messages.length, 265080);
  assert.deepEqual(archive.sources.slice().sort(), ['chat1.json', 'chat2.json']);

  // в архиве у каждого сообщения есть id из Telegram — иначе терялись бы одинаковые реплики
  let withExt = 0;
  for (const row of archive.messages) if (row[3] !== undefined) withExt++;
  assert.equal(withExt, 265080);

  // импортируем часть архива вместе с индексом, построенным ИМЕННО по этой части
  const db = newDb();
  const subset = archive.messages.slice(0, 30000).map(r => ({ role: r[0], ts: r[1], content: r[2], extId: r[3] !== undefined ? String(r[3]) : '' }));
  const stats = await db.importMessages(subset, { source: 'archive', buildIndex: false });
  assert.equal(stats.inserted, 30000);

  const built = MashaImport.buildIndex(subset.map(m => [m.role, m.ts, m.content]), { maxPostings: 1500 });
  const loaded = await db.loadIndex(built);
  assert.ok(loaded.terms > 1000, 'термов: ' + loaded.terms);
  assert.equal((await db.getStats()).terms, Object.keys(built.terms).length);

  let found = 0;
  for (const q of ['привет', 'люблю', 'фото', 'голова болит']) {
    const r = await db.recall(q, { episodeLimit: 3 });
    if (r.episodes.length) found++;
  }
  assert.ok(found >= 3, 'нашли ' + found + ' из 4 запросов');

  // файл готового индекса, который уезжает в APK, тоже должен быть валидным
  if (fs.existsSync(INDEX)) {
    const index = JSON.parse(zlib.gunzipSync(fs.readFileSync(INDEX)).toString('utf8'));
    const terms = Object.keys(index.terms || {});
    assert.ok(terms.length > 15000, 'термов в файле: ' + terms.length);
    assert.equal(index.maxPostings, 1500);
    // главное: индекс должен совпадать с текущим стеммингом, иначе память «не находит»
    for (const w of ['поссор', 'познаком', 'обид', 'готов', 'сырник', 'лошад']) {
      assert.ok(index.terms[w], 'в индексе нет основы «' + w + '» — индекс собран другим алгоритмом');
    }
    console.log('    [архив] ' + archive.count.toLocaleString('ru-RU') + ' сообщений, индекс ' + terms.length.toLocaleString('ru-RU') + ' термов, поиск работает');
  }
});
