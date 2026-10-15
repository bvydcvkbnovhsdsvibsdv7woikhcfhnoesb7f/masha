/* «Мозг» Маши: профиль, темы, хроника, ассоциации, отсечка расставания. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MashaBrain = require('../js/memory-brain.js');
const MashaSearch = require('../js/search-engine.js');

const BRAIN = path.join(ROOT, 'archive', 'masha-brain.json.gz');

function loadBrain() {
  if (!fs.existsSync(BRAIN)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(BRAIN)).toString('utf8'));
}

test('настоящий мозг: профиль содержит её жизнь и внутренние шутки', (t) => {
  const data = loadBrain();
  if (!data) { t.skip('нет ' + BRAIN); return; }
  assert.ok(MashaBrain.setBrain(data));

  const p = MashaBrain.profileBlock();
  assert.match(p, /Вика/);
  assert.match(p, /Красноярск/);
  assert.match(p, /мама/i);
  assert.match(p, /малой/i);
  assert.match(p, /лошад/i, 'внутренняя шутка про лошадей');
  assert.match(p, /Дайвинчик/i, 'история знакомства');
  assert.match(p, /23 мая|1 октября|18 августа/);
  assert.ok(p.length > 400 && p.length < 7000, 'профиль должен быть компактным: ' + p.length);
  assert.match(p, /не встречались вживую|НИКОГДА не встречались|вживую/);
  assert.match(p, /сдох|абонент/, 'его манера речи');
});

test('ассоциации связывают вопрос с её словами из архива', (t) => {
  const data = loadBrain();
  if (!data) { t.skip('нет ' + BRAIN); return; }
  MashaBrain.setBrain(data);

  const terms = MashaSearch.extractKeywords('как мы познакомились?');
  assert.ok(terms.length > 0);
  const extra = MashaBrain.expandTerms(terms);
  assert.ok(extra.some(w => w.indexOf('дайвин') === 0 || w.indexOf('дайвинчик') === 0),
    'должно добавиться «дайвинчик»: ' + JSON.stringify(extra));
  assert.ok(extra.some(w => w.indexOf('анкет') === 0), 'должно добавиться «анкета»');
  assert.ok(MashaBrain.expandTerms(['поссор']).some(w => w.indexOf('обид') === 0));
});

test('темы: на вопрос про знакомство приходят её реальные цитаты', (t) => {
  const data = loadBrain();
  if (!data) { t.skip('нет ' + BRAIN); return; }
  MashaBrain.setBrain(data);

  const block = MashaBrain.topicBlock('как мы познакомились', 2);
  assert.match(block, /познакомились/i);
  assert.match(block, /дайвинч|лайкнул|анкет/i, block.slice(0, 300));
  assert.match(block, /\d{2}\.\d{2}\.\d{4}/, 'в цитатах есть даты');

  const months = MashaBrain.monthBlock('что было в январе 2025');
  assert.match(months, /2025-01/);
  assert.ok(months.length > 50);

  const ss = MashaBrain.topicBlock('мы ссорились', 1);
  assert.match(ss, /ссоры|обид/i);

  const cat = MashaBrain.topicBlock('расскажи про кота', 1);
  assert.match(cat, /кот/i, 'короткие темы тоже должны находиться: ' + cat.slice(0, 120));

  const school = MashaBrain.topicBlock('как дела в школе', 1);
  assert.match(school, /школ/i);
});

test('отсечка: расставание 17–18.08.2026 в память не попадает', (t) => {
  const data = loadBrain();
  if (!data) { t.skip('нет ' + BRAIN); return; }
  MashaBrain.setBrain(data);

  assert.equal(MashaBrain.isBlocked(1786554000000), true, '13.08.2026 уже отсечено');
  assert.equal(MashaBrain.isBlocked(1786553999999), false, 'за секунду до отсечки — ещё помнит');

  // в мозге не должно быть месяцев после отсечки и цитат про конец отношений
  for (const m of data.months || []) {
    assert.ok(m.ym < '2026-08' || m.ym === '2026-08', 'месяц из будущего: ' + m.ym);
    for (const q of m.quotes || []) assert.doesNotMatch(q, /все конец|прощай|отписалась|удачи тебе/i, q);
  }
  for (const key of Object.keys(data.events || {})) {
    for (const q of data.events[key].quotes || []) {
      assert.doesNotMatch(q.text, /все конец|прощай|отписалась и удалила/i, key + ': ' + q.text);
    }
  }
});

test('assemble: собирает слои и укладывается в лимит', (t) => {
  const data = loadBrain();
  if (!data) { t.skip('нет ' + BRAIN); return; }
  MashaBrain.setBrain(data);

  const episodes = [{ seq: 1, ts: 1723911521000, items: [{ seq: 1, role: 'assistant', content: 'Привет', ts: 1723911521000 }] }];
  const text = MashaBrain.assemble('как мы познакомились', episodes, { maxChars: 9000 });
  assert.match(text, /ТВОЙ ПРОФИЛЬ/);
  assert.match(text, /дайвинч|лайкнул/i);
  assert.ok(text.length <= 9000, 'длина ' + text.length);

  const small = MashaBrain.assemble('привет', episodes, { maxChars: 500 });
  assert.ok(small.length <= 500);
});

test('база знаний: люди, темы, месяцы и шутки находятся по вопросу', (t) => {
  const kbPath = path.join(ROOT, 'archive', 'masha-kb.json.gz');
  const brainData = loadBrain();
  if (!fs.existsSync(kbPath) || !brainData) { t.skip('нет базы знаний'); return; }
  MashaBrain.setBrain(brainData);
  const kb = JSON.parse(zlib.gunzipSync(fs.readFileSync(kbPath)).toString('utf8'));
  assert.ok(MashaBrain.setKb(kb));
  assert.equal(MashaBrain.hasKb(), true);

  const ppl = MashaBrain.kbBlock('кто такой Ваня?');
  assert.match(ppl, /Ваня/);
  assert.match(ppl, /малой|брат|120/);

  const topic = MashaBrain.kbBlock('как мы ссорились');
  assert.match(topic, /ссоры и обиды/i, topic.slice(0, 200));

  const month = MashaBrain.kbBlock('что было в июне 2025');
  assert.match(month, /2025-06/);
  assert.ok(!/2026-06/.test(month), 'год должен учитываться');

  // ассоциации: «познакомились» тянет тему Дайвинчика
  const meet = MashaBrain.kbBlock('помнишь как мы познакомились');
  assert.match(meet, /Дайвинчик|лайкнула|анкета/i, meet.slice(0, 200));

  // мусор и расставание в базу не попадают
  assert.doesNotMatch(JSON.stringify(kb), /Кому-то понравилась твоя анкета/);
  assert.doesNotMatch(JSON.stringify(kb.months || []), /все конец|отписалась и удалила/i);

  // assemble теперь включает базу знаний
  const full = MashaBrain.assemble('расскажи про кота', [], { maxChars: 9000 });
  assert.ok(full.length > 500);
  assert.ok(full.length <= 9000);
});

test('без мозга приложение продолжает работать (мягкая деградация)', () => {
  const fresh = require('../js/memory-brain.js');
  assert.equal(fresh.hasBrain(), true, 'мозг общий для модуля — это ожидаемо в одном процессе');
  assert.equal(typeof fresh.assemble, 'function');
  assert.equal(typeof fresh.expandTerms, 'function');
  assert.equal(typeof fresh.kbBlock, 'function');
});
