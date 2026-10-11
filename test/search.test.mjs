/* Тесты MashaSearch (js/search-engine.js). Чистые функции, без DOM и БД. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const MashaSearch = require('../js/search-engine.js');

/* Загружаем файл как в браузере: без module/require, публикация в globalThis. */
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

test('модуль экспортирует весь контракт MashaSearch', () => {
  for (const name of ['STOPWORDS', 'tokenize', 'normalizeTerm', 'extractKeywords',
    'keywordsFromMany', 'rankMessages', 'buildContextBlock', 'formatDate',
    'estimateTokens', 'dedupeEpisodes']) {
    assert.ok(MashaSearch[name] !== undefined, 'нет экспорта ' + name);
  }
  assert.ok(MashaSearch.STOPWORDS instanceof Set);
});

test('tokenize: lowercase, ё→е, без пунктуации и цифр, длина >= 2', () => {
  assert.deepEqual(MashaSearch.tokenize('Привет, МИР! 123 ёжик'), ['привет', 'мир', 'ежик']);
  assert.deepEqual(MashaSearch.tokenize('  ...  !!  '), []);
  assert.deepEqual(MashaSearch.tokenize(''), []);
  assert.deepEqual(MashaSearch.tokenize(null), []);
  assert.deepEqual(MashaSearch.tokenize(undefined), []);
  assert.deepEqual(MashaSearch.tokenize('я и он'), ['он']);
  assert.deepEqual(MashaSearch.tokenize('2024-08-12'), []);
});

test('STOPWORDS: русские и английские стоп-слова', () => {
  for (const w of ['и', 'в', 'не', 'что', 'как', 'это', 'он', 'она']) {
    assert.ok(MashaSearch.STOPWORDS.has(w), 'нет стоп-слова ' + w);
  }
  for (const w of ['the', 'and', 'you', 'with']) {
    assert.ok(MashaSearch.STOPWORDS.has(w), 'нет стоп-слова ' + w);
  }
  assert.ok(!MashaSearch.STOPWORDS.has('экзамен'));
  assert.ok(!MashaSearch.STOPWORDS.has('маша'));
});

test('стемминг: «экзамены» и «экзамен» дают один терм', () => {
  const a = MashaSearch.normalizeTerm('экзамены');
  const b = MashaSearch.normalizeTerm('экзамен');
  assert.equal(a, b);
  assert.equal(a, 'экзамен');
  // нормализация идемпотентна — индекс и поиск используют одну и ту же форму
  assert.equal(MashaSearch.normalizeTerm(a), a);
  assert.equal(MashaSearch.normalizeTerm('Экзамены!'), a);
  assert.equal(MashaSearch.normalizeTerm(''), '');
});

test('extractKeywords: без стоп-слов, уникальные, длина >= 3, детерминированные', () => {
  const text = 'И вот мы сдавали экзамены, экзамен был сложный, а потом ещё один экзамен';
  const kws = MashaSearch.extractKeywords(text);
  assert.ok(kws.includes('экзамен'), 'нет терма «экзамен»: ' + JSON.stringify(kws));
  assert.ok(!kws.includes('и'));
  assert.ok(!kws.includes('вот'));
  assert.ok(!kws.includes('мы'));
  assert.equal(new Set(kws).size, kws.length, 'термы должны быть уникальны');
  assert.ok(kws.every((t) => t.length >= 3));
  assert.deepEqual(MashaSearch.extractKeywords(text), MashaSearch.extractKeywords(text));
  // «экзамены» в тексте и «экзамен» в запросе дают один и тот же терм
  assert.ok(MashaSearch.extractKeywords('сдавал экзамены вчера').includes('экзамен'));
  assert.ok(MashaSearch.extractKeywords('сдавал экзамен вчера').includes('экзамен'));
  // limit соблюдается
  const long = 'экзамен проект музыка работа планы погода машина тетрадь ручка сумка окно дверь';
  assert.equal(MashaSearch.extractKeywords(long, 5).length, 5);
  assert.equal(MashaSearch.extractKeywords(long, 1).length, 1);
});

test('keywordsFromMany: термины из нескольких текстов, частые выше', () => {
  const kws = MashaSearch.keywordsFromMany([
    'экзамен и проект',
    'экзамен и работа',
    'погода'
  ], 5);
  assert.equal(kws[0], 'экзамен');
  assert.ok(kws.includes('проект'));
  assert.ok(kws.includes('работ'));
  assert.deepEqual(kws, MashaSearch.keywordsFromMany(['экзамен и проект', 'экзамен и работа', 'погода'], 5));
  assert.deepEqual(MashaSearch.keywordsFromMany([], 5), []);
});

test('rankMessages: релевантное выше свежего, нерелевантные отброшены', () => {
  const messages = [
    { id: 1, content: 'игра и снова игры', ts: 1000 },
    { id: 2, content: 'игра', ts: 9000 },
    { id: 3, content: 'игра и экзамен', ts: 500 },
    { id: 4, content: 'погода и дождь', ts: 9500 }
  ];
  const ranked = MashaSearch.rankMessages(messages, ['игра', 'экзамен']);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].msg.id, 3, 'два разных терма важнее свежести');
  assert.ok(ranked.every((r) => r.msg.id !== 4), 'нерелевантное не должно попадать');
  for (const r of ranked) assert.equal(typeof r.score, 'number');

  const fresh = MashaSearch.rankMessages([
    { id: 'old', content: 'экзамен', ts: 1000 },
    { id: 'new', content: 'экзамен', ts: 9000 }
  ], ['экзамен']);
  assert.equal(fresh[0].msg.id, 'new', 'при равной релевантности выше свежее');

  // нормализация запроса: «Экзамены» находит «экзамен»
  const stemmed = MashaSearch.rankMessages([{ id: 'x', content: 'сдал экзамен', ts: 1 }], ['Экзамены']);
  assert.equal(stemmed.length, 1);
});

test('buildContextBlock: формат, роли он/она, переводы строк схлопнуты', () => {
  const ts1 = new Date(2024, 7, 12, 21, 14).getTime();
  const ts2 = new Date(2024, 7, 12, 21, 15).getTime();
  const episodes = [{
    seq: 10,
    ts: ts1,
    items: [
      { id: 1, seq: 9, role: 'user', content: 'помнишь как мы\nпоссорились из-за игры', ts: ts1 },
      { id: 2, seq: 10, role: 'assistant', content: 'ага, ты тогда\nобиделся', ts: ts2 }
    ]
  }];
  const block = MashaSearch.buildContextBlock(episodes);
  const lines = block.split('\n');
  assert.equal(lines[0], '[ФРАГМЕНТЫ ИЗ АРХИВА ПЕРЕПИСКИ (реальные старые сообщения)]');
  assert.equal(lines[1], '--- 12.08.2024 21:14 ---');
  assert.equal(lines[2], 'он: помнишь как мы поссорились из-за игры');
  assert.equal(lines[3], 'она: ага, ты тогда обиделся');

  const custom = MashaSearch.buildContextBlock(episodes, { header: 'СТАРОЕ' });
  assert.ok(custom.startsWith('[СТАРОЕ]\n'));

  assert.equal(MashaSearch.buildContextBlock([], {}), '');
  assert.equal(MashaSearch.buildContextBlock(null, {}), '');
});

test('buildContextBlock не превышает maxChars и режет по целым строкам', () => {
  const episodes = [];
  for (let i = 0; i < 50; i++) {
    episodes.push({
      seq: i + 1,
      ts: new Date(2024, 0, 1, 10, i).getTime(),
      items: [
        { id: i * 2, seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: ('сообщение про игры ').repeat(10), ts: 0 },
        { id: i * 2 + 1, seq: i + 1, role: 'assistant', content: 'короткий ответ', ts: 0 }
      ]
    });
  }
  for (const maxChars of [1, 10, 60, 200, 1000, 3500]) {
    const block = MashaSearch.buildContextBlock(episodes, { maxChars });
    assert.ok(block.length <= maxChars, 'длина ' + block.length + ' > ' + maxChars);
  }
  const big = MashaSearch.buildContextBlock(episodes, { maxChars: 3500 });
  assert.ok(big.length > 300, 'нормальный контекст не должен схлопываться');
  assert.equal(MashaSearch.buildContextBlock(episodes, { maxChars: 0 }), '');
});

test('formatDate и estimateTokens', () => {
  const ts = new Date(2024, 7, 12, 21, 14).getTime();
  assert.equal(MashaSearch.formatDate(ts), '12.08.2024 21:14');
  assert.equal(MashaSearch.formatDate(new Date(2024, 0, 5, 9, 7).getTime()), '05.01.2024 09:07');
  assert.equal(MashaSearch.formatDate(0), '');
  assert.equal(MashaSearch.formatDate(-1), '');
  assert.equal(MashaSearch.formatDate(null), '');
  assert.equal(MashaSearch.formatDate('нет'), '');

  assert.equal(MashaSearch.estimateTokens(''), 0);
  assert.equal(MashaSearch.estimateTokens(null), 0);
  assert.equal(MashaSearch.estimateTokens('abcd'), 1);
  assert.equal(MashaSearch.estimateTokens('a'.repeat(9)), 3);
});

test('dedupeEpisodes убирает дубли и не трогает разные эпизоды', () => {
  const ep1 = { seq: 10, ts: 1, items: [{ id: 1, seq: 10, role: 'user', content: 'а' }] };
  const ep2 = { seq: 10, ts: 1, items: [{ id: 1, seq: 10, role: 'user', content: 'а' }] };
  const ep3 = { seq: 20, ts: 2, items: [{ id: 2, seq: 20, role: 'user', content: 'б' }] };
  const out = MashaSearch.dedupeEpisodes([ep1, ep2, ep3, null, undefined]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.seq), [10, 20]);
  assert.deepEqual(MashaSearch.dedupeEpisodes(null), []);
});

test('UMD: в браузере модуль публикуется как globalThis.MashaSearch', () => {
  const browser = makeBrowserContext();
  browser.load('search-engine.js');
  const api = browser.ctx.MashaSearch;
  assert.ok(api, 'MashaSearch не опубликован в globalThis');
  assert.equal(typeof api.extractKeywords, 'function');
  assert.equal(typeof api.buildContextBlock, 'function');
  assert.ok(api.extractKeywords('сдавал экзамены вчера').includes('экзамен'));
  assert.equal(api.formatDate(new Date(2024, 7, 12, 21, 14).getTime()), '12.08.2024 21:14');
});

test('пустой ввод не роняет функции', () => {
  assert.deepEqual(MashaSearch.extractKeywords(''), []);
  assert.deepEqual(MashaSearch.extractKeywords(null), []);
  assert.deepEqual(MashaSearch.extractKeywords(undefined), []);
  assert.deepEqual(MashaSearch.rankMessages([], ['x']), []);
  assert.deepEqual(MashaSearch.rankMessages(null, null), []);
  assert.deepEqual(MashaSearch.rankMessages([{ id: 1, content: 'привет', ts: 1 }], []), []);
  assert.equal(MashaSearch.buildContextBlock(undefined, undefined), '');
  assert.deepEqual(MashaSearch.dedupeEpisodes([]), []);
  assert.equal(MashaSearch.estimateTokens(undefined), 0);
  assert.equal(MashaSearch.normalizeTerm(undefined), '');
  assert.deepEqual(MashaSearch.tokenize(123), []);
});
