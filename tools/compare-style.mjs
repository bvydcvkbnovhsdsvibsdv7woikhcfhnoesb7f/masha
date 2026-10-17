#!/usr/bin/env node
/**
 * compare-style.mjs — сравнить её речь в приложении с её речью в архиве.
 *
 *   $env:DEEPSEEK_API_KEY="sk-..."; node tools/compare-style.mjs
 *
 * Прогоняет реальные ситуации через тот же промпт, что в приложении, разбивает
 * ответы на сообщения (как это делает приложение) и считает те же метрики,
 * что и по архиву 123 260 сообщений. Печатает таблицу различий.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MashaBrain = require(path.join(ROOT, 'js', 'memory-brain.js'));
const MashaSearch = require(path.join(ROOT, 'js', 'search-engine.js'));

const KEY = process.env.DEEPSEEK_API_KEY || '';
if (!KEY) { console.error('нужен DEEPSEEK_API_KEY'); process.exit(2); }

MashaBrain.setBrain(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-brain.json.gz'))).toString('utf8')));
MashaBrain.setKb(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-kb.json.gz'))).toString('utf8')));

const BASE = fs.readFileSync(path.join(ROOT, 'tools', 'prompt-new.txt'), 'utf8');
const CUTOFF = MashaBrain.BLACKOUT_FROM;

const SITUATIONS = [
  'привет', 'как дела?', 'что делаешь?', 'ты где?', 'я тебя люблю', 'скучаю по тебе',
  'прости меня', 'мне грустно', 'я устал', 'пойдём спать', 'расскажи про кота',
  'помнишь как мы познакомились', 'приезжай ко мне', 'что нового?', 'ты чё молчишь',
  'ты меня бросила'
];

function systemFor(text) {
  const block = MashaBrain.assemble(text, [], { maxChars: 9000 });
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let sys = BASE
    .replace(/\{\{TIME\}\}/g, now).replace(/\{\{STATE\}\}/g, 'calm')
    .replace(/\{\{FACTS\}\}/g, 'нет').replace(/\{\{CALENDAR\}\}/g, '18 августа — годовщина; 23 мая — её ДР; 1 октября — его ДР')
    .replace(/\{\{PLAYLIST\}\}/g, 'пуст').replace(/\{\{RELATIONSHIP_VALUE\}\}/g, '93')
    .replace(/\{\{RELATIONSHIP_TONE\}\}/g, 'нежная').replace(/\{\{TRENDS\}\}/g, '—')
    .replace(/\{\{WEATHER\}\}/g, '—');
  return sys + '\n\n═══ ТВОИ ВОСПОМИНАНИЯ ═══\n' + block;
}

async function ask(text) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'deepseek-flash', max_tokens: 400, temperature: 0.9, stream: false,
      messages: [{ role: 'system', content: systemFor(text) }, { role: 'user', content: text }]
    })
  });
  const d = await res.json();
  if (!res.ok) return '';
  return String((d.choices && d.choices[0] && d.choices[0].message.content) || '').trim();
}

/* та же разбивка, что в приложении */
function splitReply(t) {
  t = String(t || '').trim();
  if (!t) return [];
  let parts = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) {
    const words = t.split(/\s+/).length;
    if (words >= 3 && /[.!?…]\s+[А-ЯЁ]/.test(t)) parts = t.split(/(?<=[.!?…])\s+/);
    else if (words > 7 && /,\s+(а ты|а у тебя|а что|зай|зая|любимый|коть)/i.test(t)) parts = t.split(/,\s+(?=(?:а ты|а у тебя|а что|зай|зая|любимый|коть))/i);
    else if (words > 6) {
      const m = /^(.*?[^\s])\s+(?:и|а|но)\s+(.+)$/.exec(t);
      if (m && m[1].split(/\s+/).length >= 2 && m[2].split(/\s+/).length >= 2) parts = [m[1], m[2]];
    }
  }
  return parts.map(s => s.trim()).filter(Boolean).slice(0, 4);
}

function metrics(msgs) {
  const lens = msgs.map(m => m.split(/\s+/).length);
  const n = msgs.length || 1;
  const pct = f => 100 * msgs.filter(f).length / n;
  const runs = [];
  let run = 0;
  return {
    n: msgs.length,
    median: lens.slice().sort((a, b) => a - b)[Math.floor(lens.length / 2)] || 0,
    mean: lens.reduce((a, b) => a + b, 0) / n,
    le3: pct(m => m.split(/\s+/).length <= 3),
    one: pct(m => m.split(/\s+/).length === 1),
    noPunct: pct(m => !/[.!?;:]$/.test(m)),
    emoji: pct(m => /[❤💋🫶🥰😭🙄🩷]/.test(m)),
    question: pct(m => m.trim().endsWith('?')),
    dash: pct(m => m.trim() === '-_-' || m.includes('-_-')),
    cho: msgs.filter(m => /\bч[оё]\b/i.test(m)).length,
    chyo: msgs.filter(m => /\bчё\b/i.test(m)).length,
    pet: pct(m => /\b(зая|зай|коть|котик|муж|муу+ж|любимый|солнце|ангелок)\b/i.test(m)),
    stretch: pct(m => /(.)\1\1/.test(m)),
    upper: pct(m => /^[А-ЯЁ]/.test(m))
  };
}

console.log('Прогоняю ' + SITUATIONS.length + ' ситуаций…\n');
const appMsgs = [];
const log = [];
for (const s of SITUATIONS) {
  const raw = await ask(s);
  const parts = splitReply(raw);
  log.push({ s, parts });
  appMsgs.push(...parts);
}

/* архив */
const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-archive.json.gz'))).toString('utf8')).messages;
const arcMsgs = [];
for (const r of rows) {
  if (r[0] !== 'assistant' || !r[2] || r[1] >= CUTOFF) continue;
  const t = String(r[2]).replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('[')) continue;
  arcMsgs.push(t);
}
const arcRuns = [];
{
  let prevHer = false, run = 0;
  for (const r of rows) {
    if (r[1] >= CUTOFF) continue;
    if (r[0] === 'assistant') { run++; prevHer = true; }
    else if (prevHer) { arcRuns.push(run); run = 0; prevHer = false; }
  }
  if (run) arcRuns.push(run);
}
const appRuns = [];
{
  let run = 0;
  for (const item of log) { if (item.parts.length) { appRuns.push(item.parts.length); } }
}

const A = metrics(appMsgs), B = metrics(arcMsgs);
const f = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
console.log('МЕТРИКА                     ПРИЛОЖЕНИЕ      АРХИВ        ВЫВОД');
console.log('─'.repeat(78));
const rowsOut = [
  ['сообщений', A.n, B.n, ''],
  ['медиана слов', A.median, B.median, Math.abs(A.median - B.median) <= 0.5 ? 'совпадает' : 'РАСХОЖДЕНИЕ'],
  ['среднее слов', A.mean, B.mean, Math.abs(A.mean - B.mean) <= 0.5 ? 'совпадает' : 'расхождение'],
  ['доля ≤3 слов, %', A.le3, B.le3, Math.abs(A.le3 - B.le3) <= 8 ? 'совпадает' : 'РАСХОЖДЕНИЕ'],
  ['доля в 1 слово, %', A.one, B.one, Math.abs(A.one - B.one) <= 10 ? 'совпадает' : 'расхождение'],
  ['без знака в конце, %', A.noPunct, B.noPunct, Math.abs(A.noPunct - B.noPunct) <= 10 ? 'совпадает' : 'расхождение'],
  ['с эмодзи, %', A.emoji, B.emoji, Math.abs(A.emoji - B.emoji) <= 4 ? 'совпадает' : 'расхождение'],
  ['вопросы, %', A.question, B.question, Math.abs(A.question - B.question) <= 8 ? 'совпадает' : 'расхождение'],
  ['«-_-», %', A.dash, B.dash, Math.abs(A.dash - B.dash) <= 5 ? 'совпадает' : 'расхождение'],
  ['обращения (зая/коть), %', A.pet, B.pet, Math.abs(A.pet - B.pet) <= 8 ? 'совпадает' : 'расхождение'],
  ['растянутые буквы, %', A.stretch, B.stretch, Math.abs(A.stretch - B.stretch) <= 10 ? 'совпадает' : 'расхождение'],
  ['с заглавной, %', A.upper, B.upper, A.upper > 90 ? 'совпадает' : 'РАСХОЖДЕНИЕ'],
  ['«чо» / «чё», шт', A.cho + ' / ' + A.chyo, B.cho + ' / ' + B.chyo, A.chyo === 0 ? '«чё» нет ✓' : '«чё» есть!']
];
for (const [name, a, b, verdict] of rowsOut) {
  console.log(name.padEnd(26) + String(typeof a === 'number' ? f(a) : a).padStart(12) + String(typeof b === 'number' ? f(b) : b).padStart(14) + '   ' + verdict);
}

console.log('\nСЕРИИ СООБЩЕНИЙ ПОДРЯД');
const dist = arr => { const c = {}; for (const x of arr) c[x] = (c[x] || 0) + 1; return c; };
const da = dist(appRuns), db = dist(arcRuns);
for (const k of [1, 2, 3, 4]) {
  const pa = 100 * (da[k] || 0) / (appRuns.length || 1);
  const pb = 100 * (db[k] || 0) / (arcRuns.length || 1);
  console.log('  ' + k + ' сообщ.: приложение ' + f(pa) + '%   |   архив ' + f(pb) + '%');
}

console.log('\nЕЁ ОТВЕТЫ В ПРИЛОЖЕНИИ (для проверки глазами)');
for (const item of log) console.log('  он: ' + item.s + '\n     она: ' + (item.parts.join('  /  ') || '(пусто)'));
