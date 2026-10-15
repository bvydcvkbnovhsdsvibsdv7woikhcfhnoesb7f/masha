/* Поиск и текст: ключевые слова, стемминг, блок воспоминаний. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/search-engine.js');

test('tokenize: lowercase, ё→е, без пунктуации', () => {
  assert.deepEqual(S.tokenize('Привет, Ёжик!'), ['привет', 'ежик']);
  assert.deepEqual(S.tokenize(''), []);
  assert.deepEqual(S.tokenize(null), []);
});

test('стемминг: «экзамены» и «экзамен» дают один терм', () => {
  assert.equal(S.normalizeTerm('экзамены'), S.normalizeTerm('экзамен'));
  assert.equal(S.normalizeTerm('сырниками'), S.normalizeTerm('сырники'));
  assert.equal(S.normalizeTerm('поссорились'), S.normalizeTerm('поссорился'));
});

test('extractKeywords: без стоп-слов, без мусора, детерминированно', () => {
  const kw = S.extractKeywords('ну я вообще не знаю, помнишь как мы поссорились из-за игры');
  assert.ok(kw.includes('поссор') || kw.some(k => k.startsWith('поссор')), JSON.stringify(kw));
  assert.ok(kw.includes('игр') || kw.some(k => k.startsWith('игр')), JSON.stringify(kw));
  assert.ok(!kw.includes('вообще'));
  assert.ok(!kw.includes('знаю'));
  assert.deepEqual(S.extractKeywords('кот болит голова'), S.extractKeywords('кот болит голова'));
  assert.equal(S.extractKeywords('в и на').length, 0);
});

test('buildContextBlock: роли он/она, дата, лимит символов', () => {
  const episodes = [{
    seq: 10, ts: Date.UTC(2024, 7, 18, 15, 0, 0),
    items: [
      { seq: 9, role: 'user', content: 'я психанул из-за игры', ts: 0 },
      { seq: 10, role: 'assistant', content: 'блин, ну ты даешь\nэто же просто игра', ts: 0 }
    ]
  }];
  const block = S.buildContextBlock(episodes, { maxChars: 2000 });
  assert.match(block, /ФРАГМЕНТЫ ИЗ АРХИВА/i);
  assert.match(block, /он: я психанул/);
  assert.match(block, /она: блин, ну ты даешь это же просто игра/);
  assert.match(block, /\d{2}\.\d{2}\.\d{4}/);
  assert.ok(block.length <= 2000);

  const tiny = S.buildContextBlock(episodes, { maxChars: 40 });
  assert.ok(tiny.length <= 40, 'длина ' + tiny.length);
  assert.equal(S.buildContextBlock([], { maxChars: 100 }), '');
});

test('dedupeEpisodes: пересекающиеся эпизоды схлопываются', () => {
  const a = { seq: 10, items: [{ seq: 9 }, { seq: 10 }] };
  const b = { seq: 11, items: [{ seq: 10 }, { seq: 11 }] };
  const c = { seq: 50, items: [{ seq: 50 }] };
  assert.deepEqual(S.dedupeEpisodes([a, b, c]).map(e => e.seq), [10, 50]);
});

test('formatDate и estimateTokens', () => {
  assert.match(S.formatDate(Date.UTC(2024, 0, 5, 12, 30)), /05\.01\.2024/);
  assert.equal(S.formatDate(0), '');
  assert.equal(S.estimateTokens('привет'), 2);
});
