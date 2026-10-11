/* Тесты MashaMemory (js/memory-db.js) на in-memory шиме IndexedDB. */
import { describe, it, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import { FakeIndexedDB, IDBKeyRange } from './fake-idb.mjs';

const require = createRequire(import.meta.url);
const MashaMemory = require('../js/memory-db.js');
const MashaSearch = require('../js/search-engine.js');

/* Загружаем файлы как в браузере: без module/require, публикация в globalThis. */
function makeBrowserContext() {
  const sandbox = { console, queueMicrotask, setTimeout, clearTimeout, Math, Date, JSON };
  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    load(file) {
      const code = fs.readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');
      vm.runInContext(code, ctx, { filename: file });
      return ctx;
    }
  };
}

const BASE = new Date(2023, 0, 1, 12, 0, 0).getTime();
const MINUTE = 60000;

let dbCounter = 0;
function newDb(extra) {
  dbCounter++;
  return MashaMemory.create(Object.assign({
    indexedDB: new FakeIndexedDB(),
    IDBKeyRange: IDBKeyRange,
    name: 'masha_test_' + dbCounter + '_' + Date.now()
  }, extra || {}));
}

/* 5000 синтетических сообщений; каждое 500-е — про экзамены. */
function buildMessages(n) {
  const roles = ['user', 'assistant'];
  const out = [];
  for (let i = 0; i < n; i++) {
    let content;
    if (i % 500 === 0) content = 'сегодня сдавал экзамены, очень волновался, сообщение ' + i;
    else if (i % 7 === 0) content = 'болтали про игры и музыку, сообщение ' + i;
    else content = 'обычное сообщение про работу и планы, сообщение ' + i;
    out.push({ role: roles[i % 2], content, ts: BASE + i * MINUTE, iso: '', day: '', src: 'archive' });
  }
  return out;
}

describe('MashaMemory: архив на 5000 сообщений', () => {
  let db;
  let messages;
  let stats;
  let progress;
  let elapsed;

  before(async () => {
    db = newDb();
    messages = buildMessages(5000);
    progress = [];
    const t0 = Date.now();
    stats = await db.importMessages(messages, {
      source: 'archive',
      batchSize: 500,
      onProgress: (done, total) => progress.push([done, total])
    });
    elapsed = Date.now() - t0;
  });

  it('импорт: батчи, прогресс, статистика', () => {
    assert.equal(stats.inserted, 5000);
    assert.equal(stats.duplicates, 0);
    assert.equal(stats.skipped, 0);
    assert.ok(stats.terms > 0, 'термы должны попасть в индекс');
    assert.equal(typeof stats.durationMs, 'number');
    assert.equal(progress.length, 10, 'onProgress должен вызываться после каждого батча');
    assert.deepEqual(progress[progress.length - 1], [5000, 5000]);
    assert.ok(progress.every((p) => p[1] === 5000));
    assert.ok(elapsed < 20000, 'импорт 5000 сообщений занял ' + elapsed + ' мс');
  });

  it('count/getStats: объём, источники, границы по датам', async () => {
    assert.equal(await db.count(), 5000);
    const st = await db.getStats();
    assert.equal(st.messages, 5000);
    assert.ok(st.terms > 0);
    assert.equal(st.oldest, BASE);
    assert.equal(st.newest, BASE + 4999 * MINUTE);
    assert.deepEqual(st.sources, ['archive']);
    assert.ok(st.estBytes > 0);
  });

  it('search находит сообщения про экзамен', async () => {
    const found = await db.search(['экзамен'], { limit: 40 });
    assert.equal(found.length, 10);
    for (const hit of found) {
      assert.ok(hit.msg.content.includes('экзамен'));
      assert.equal(typeof hit.msg.seq, 'number');
      assert.equal(typeof hit.msg.id, 'number');
      assert.equal(typeof hit.score, 'number');
      assert.equal(hit.msg.src, 'archive');
    }
    // поиск идемпотентен по нормализации: «Экзамены» → «экзамен»
    const upper = await db.search(['Экзамены'], { limit: 40 });
    assert.equal(upper.length, 10);
    assert.deepEqual(upper.map((h) => h.msg.seq), found.map((h) => h.msg.seq));

    assert.deepEqual(await db.search([], {}), []);
    assert.deepEqual(await db.search(['нетакогослова']), []);
    assert.deepEqual(await db.search(['экзамен'], { limit: 0 }), []);
    const limited = await db.search(['экзамен'], { limit: 3 });
    assert.equal(limited.length, 3);
  });

  it('recall возвращает эпизоды с соседями по seq', async () => {
    const res = await db.recall('когда я сдавал экзамены', { episodeLimit: 3, radius: 1 });
    assert.ok(res.matched >= 3);
    assert.equal(res.episodes.length, 3);
    assert.equal(typeof res.tookMs, 'number');
    for (const ep of res.episodes) {
      const seqs = ep.items.map((i) => i.seq);
      assert.ok(seqs.includes(ep.seq), 'в эпизоде должен быть сам найденный seq');
      assert.ok(seqs.length >= 2, 'должны быть соседи');
      for (const s of seqs) assert.ok(Math.abs(s - ep.seq) <= 1, 'сосед вне radius');
      assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), 'внутри эпизода — хронология');
      assert.ok(ep.ts > 0);
      for (const item of ep.items) {
        assert.ok(['user', 'assistant'].includes(item.role));
        assert.equal(typeof item.content, 'string');
      }
    }
    assert.ok(res.episodes[0].seq > res.episodes[1].seq, 'свежие эпизоды первыми');

    const wide = await db.recall('экзамены', { episodeLimit: 1, radius: 2 });
    assert.equal(wide.episodes[0].items.length, 5);

    const empty = await db.recall('и в на это', {});
    assert.deepEqual(empty.episodes, []);
    assert.equal(empty.matched, 0);
  });

  it('getRecent — хронологический порядок, getNeighbors — окно по seq', async () => {
    const recent = await db.getRecent(5);
    assert.deepEqual(recent.map((m) => m.seq), [4996, 4997, 4998, 4999, 5000]);
    assert.deepEqual(recent.map((m) => m.ts), recent.map((m) => m.ts).slice().sort((a, b) => a - b));
    assert.equal(recent[4].content, messages[4999].content);

    const neighbors = await db.getNeighbors(100, 2);
    assert.deepEqual(neighbors.map((m) => m.seq), [98, 99, 100, 101, 102]);
    assert.deepEqual((await db.getNeighbors(1, 2)).map((m) => m.seq), [1, 2, 3]);
    assert.deepEqual(await db.getNeighbors(0, 2), []);
    assert.equal((await db.getRecent(0)).length, 0);
  });

  it('повторный импорт не удваивает архив (hashes)', async () => {
    const again = await db.importMessages(messages, { batchSize: 500, source: 'archive' });
    assert.equal(again.inserted, 0);
    assert.equal(again.duplicates, 5000);
    assert.equal(await db.count(), 5000);
    const found = await db.search(['экзамен'], { limit: 40 });
    assert.equal(found.length, 10);
  });
});

test('maxPostings: постинг-лист обрезается самыми свежими seq', async () => {
  const db = newDb();
  const list = [];
  for (let i = 0; i < 6; i++) {
    list.push({ role: 'user', content: 'проект маша и наши дела', ts: BASE + i * MINUTE, src: 'archive' });
  }
  const stats = await db.importMessages(list, { maxPostings: 3 });
  assert.equal(stats.inserted, 6);
  const found = await db.search(['проект'], { limit: 10 });
  assert.equal(found.length, 3, 'в постинге должно остаться только maxPostings ссылок');
  assert.deepEqual(found.map((h) => h.msg.seq).sort((a, b) => a - b), [4, 5, 6]);
});

test('неотсортированный вход раскладывается по ts и получает seq по порядку', async () => {
  const db = newDb();
  const stats = await db.importMessages([
    { role: 'user', content: 'третье по времени', ts: BASE + 3000 },
    { role: 'assistant', content: 'первое по времени', ts: BASE + 1000 },
    { role: 'user', content: 'второе по времени', ts: BASE + 2000 }
  ], {});
  assert.equal(stats.inserted, 3);
  const recent = await db.getRecent(10);
  assert.deepEqual(recent.map((m) => m.content),
    ['первое по времени', 'второе по времени', 'третье по времени']);
  assert.deepEqual(recent.map((m) => m.seq), [1, 2, 3]);
  assert.equal(recent[0].iso, MashaMemory._internals.isoFromTs(BASE + 1000));
  assert.equal(recent[0].day, MashaMemory._internals.dayFromTs(BASE + 1000));
});

test('мусор и неизвестные роли пропускаются, skipDuplicates:false дублирует', async () => {
  const db = newDb();
  const stats = await db.importMessages([
    null,
    'строка',
    {},
    { role: 'кто-то', content: 'непонятно' },
    { role: 'user', content: '   ' },
    { role: 'user', content: 'нормальное сообщение', ts: BASE }
  ], {});
  assert.equal(stats.skipped, 5);
  assert.equal(stats.inserted, 1);
  assert.equal(await db.count(), 1);

  const db2 = newDb();
  const same = [
    { role: 'user', content: 'одно и то же', ts: BASE },
    { role: 'assistant', content: 'разное', ts: BASE + 1 }
  ];
  await db2.importMessages(same, { skipDuplicates: false });
  const second = await db2.importMessages(same, { skipDuplicates: false });
  assert.equal(second.inserted, 2);
  assert.equal(await db2.count(), 4);

  const db3 = newDb();
  const empty = [];
  const seen = [];
  const third = await db3.importMessages([], { onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(third.inserted, 0);
  assert.equal(third.duplicates, 0);
  assert.deepEqual(seen, [[0, 0]]);

  const noIndex = newDb();
  await noIndex.importMessages(buildMessages(100), { buildIndex: false });
  assert.equal((await noIndex.getStats()).terms, 0);
  assert.deepEqual(await noIndex.search(['экзамен']), []);
});

test('append: живое сообщение, индексация, ошибки, clear', async () => {
  const db = newDb();
  const id = await db.append({ role: 'user', content: 'привет, как дела', ts: BASE });
  assert.ok(id > 0);
  assert.equal(await db.count(), 1);

  const id2 = await db.append({ role: 'assistant', content: 'всё хорошо, экзамен сдал' });
  assert.ok(id2 > id);
  assert.equal(await db.count(), 2);

  const recent = await db.getRecent(5);
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((m) => m.seq), [1, 2]);
  assert.equal(recent[0].src, 'live');
  assert.ok(recent[1].ts > 0);
  assert.equal(recent[1].role, 'assistant');

  // живое сообщение сразу попадает в индекс
  const found = await db.search(['экзамен']);
  assert.equal(found.length, 1);
  assert.equal(found[0].msg.seq, 2);

  await assert.rejects(() => db.append({ role: 'кто-то', content: 'текст' }));
  await assert.rejects(() => db.append({ role: 'user', content: '   ' }));
  await assert.rejects(() => db.append({}));

  const st = await db.getStats();
  assert.equal(st.messages, 2);
  assert.ok(st.terms >= 2);
  assert.ok(st.estBytes > 0);
  assert.deepEqual(st.sources, ['live']);
  assert.equal(st.oldest, BASE);

  await db.clear();
  assert.equal(await db.count(), 0);
  const cleared = await db.getStats();
  assert.equal(cleared.messages, 0);
  assert.equal(cleared.terms, 0);
  assert.deepEqual(cleared.sources, []);

  // после clear нумерация seq начинается заново
  await db.append({ role: 'user', content: 'после очистки' });
  assert.equal((await db.getRecent(1))[0].seq, 1);
});

test('open(): singleton для браузера + create() даёт независимые БД', async () => {
  const singleton = await MashaMemory.open({
    indexedDB: new FakeIndexedDB(),
    IDBKeyRange: IDBKeyRange,
    name: 'masha_singleton_' + Date.now()
  });
  assert.equal(MashaMemory.db, singleton);
  assert.ok(singleton instanceof MashaMemory.MemoryDb);
  const again = await MashaMemory.open();
  assert.equal(again, singleton);
  await singleton.append({ role: 'user', content: 'в синглтоне' });
  assert.equal(await singleton.count(), 1);
  await singleton.clear();
  assert.equal(await singleton.count(), 0);

  const a = newDb();
  const b = newDb();
  await a.append({ role: 'user', content: 'только в a' });
  assert.equal(await a.count(), 1);
  assert.equal(await b.count(), 0);
  await a.close();
});

test('MashaMemory.create работает и без явного IDBKeyRange (берёт глобальный)', async () => {
  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), name: 'masha_nokr_' + Date.now() });
  await db.importMessages(buildMessages(20), { batchSize: 10 });
  assert.equal(await db.count(), 20);
  assert.equal((await db.getNeighbors(5, 1)).length, 3);
});

test('UMD: в браузере MashaMemory работает через globalThis и видит global MashaSearch', async () => {
  const browser = makeBrowserContext();
  browser.load('search-engine.js');
  browser.load('memory-db.js');
  const mem = browser.ctx.MashaMemory;
  const search = browser.ctx.MashaSearch;
  assert.ok(mem, 'MashaMemory не опубликован в globalThis');
  assert.ok(search, 'MashaSearch не опубликован в globalThis');
  assert.equal(mem.db, null);

  const db = mem.create({ indexedDB: new FakeIndexedDB(), name: 'masha_browser_' + Date.now() });
  await db.importMessages([
    { role: 'user', content: 'сдавал экзамены вчера вечером', ts: BASE },
    { role: 'assistant', content: 'ну и как всё прошло', ts: BASE + 1 }
  ], {});
  assert.equal(await db.count(), 2);

  // поиск нашёл терм => использован MashaSearch из глобального окружения
  const found = await db.search(['экзамен']);
  assert.equal(found.length, 1);
  assert.equal(typeof found[0].msg.seq, 'number');

  const rec = await db.recall('помнишь как я сдавал экзамены', { radius: 1 });
  assert.ok(rec.episodes.length >= 1);
  assert.ok(rec.episodes[0].items.length >= 1);
  assert.ok(search.buildContextBlock(rec.episodes).includes('экзамен'));
});

test('нормализация термов индекса совпадает с MashaSearch (экзамены/экзамен)', async () => {
  const db = newDb();
  await db.importMessages([
    { role: 'user', content: 'завтра экзамены по математике', ts: BASE },
    { role: 'assistant', content: 'не переживай', ts: BASE + 1 }
  ], {});
  const terms = MashaSearch.extractKeywords('завтра экзамены по математике');
  assert.ok(terms.includes('экзамен'));
  const found = await db.search(terms);
  assert.equal(found.length, 1);
});
