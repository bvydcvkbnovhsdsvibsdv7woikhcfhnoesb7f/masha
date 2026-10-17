#!/usr/bin/env node
/**
 * check-all.mjs — полная ревизия проекта: код, архив, индекс, приложение.
 *
 *   node tools/check-all.mjs
 *
 * Проверяет:
 *   • все обязательные файлы на месте и не пустые;
 *   • синтаксис каждого js-файла и корректность каждого json;
 *   • архив: количество сообщений, роли, период;
 *   • индекс: термы, лимит ссылок И ГЛАВНОЕ — совпадение индекса с текущим
 *     стеммингом (из-за расхождения память «не находила» воспоминания);
 *   • index.html: один inline-скрипт, все обработчики определены, версия промпта;
 *   • адреса релея одинаковы в config.js, index.html и workflow;
 *   • готовность к сборке APK (архив, модули, иконки).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MashaSearch = require(path.join(ROOT, 'js', 'search-engine.js'));

let problems = 0, warns = 0, checks = 0;
const ok = (m) => { checks++; console.log('  ✓ ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };
const bad = (m) => { problems++; console.log('  ✖ ' + m); };
const head = (t) => { console.log('\n' + t); console.log('─'.repeat(Math.max(20, t.length))); };
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' КБ';

/* ---------- 1. файлы ---------- */
head('ФАЙЛЫ');
const REQUIRED = [
  ['index.html', 50], ['sw.js', 1], ['manifest.json', 0.3], ['vercel.json', 0.2],
  ['js/search-engine.js', 5], ['js/memory-db.js', 15], ['js/import-manager.js', 15],
  ['js/api-client.js', 10], ['js/initiative.js', 5], ['js/config.js', 0.2],
  ['worker/worker.js', 8], ['worker/local-relay.py', 5], ['worker/local-relay.mjs', 2],
  ['worker/deno-relay.js', 8], ['worker/netlify-relay.js', 8], ['api/relay.js', 8],
  ['archive/masha-archive.json.gz', 1000], ['archive/masha-index.json.gz', 300],
  ['tools/build-archive.mjs', 3], ['tools/rebuild-index.mjs', 2], ['tools/apply-prompt.mjs', 2],
  ['tools/check-key.py', 2], ['tools/mine-style.py', 3], ['tools/analyze-pairs.py', 3],
  ['tools/prompt-new.txt', 5], ['.github/workflows/build-apk.yml', 3],
  ['PROMPT.md', 5], ['README-FIX.md', 5]
];
for (const [rel, minKb] of REQUIRED) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { bad('нет файла: ' + rel); continue; }
  const k = fs.statSync(p).size / 1024;
  if (k < minKb) bad(rel + ' подозрительно маленький: ' + k.toFixed(1) + ' КБ');
  else ok(rel + ' — ' + k.toFixed(1) + ' КБ');
}
for (const extra of ['avatars', 'icon-192.png', 'icon-512.png']) {
  if (fs.existsSync(path.join(ROOT, extra))) ok('есть ' + extra + ' (не удалять из репозитория)');
  else warn('нет ' + extra + ' — на сайте и в APK не будет картинок (в репозитории они должны быть)');
}

/* ---------- 2. синтаксис ---------- */
head('СИНТАКСИС');
function walk(dir, filter) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(e.name)) out.push(p);
  }
  return out;
}
for (const file of walk(ROOT, n => n.endsWith('.js'))) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const isModule = /^\s*export\s+(default|\{)/m.test(src) || rel.includes('worker.mjs');
  try {
    if (isModule) {
      // ES-модуль (воркер, Deno, Vercel): убираем export-объявления и проверяем остальное
      const body = src
        .replace(/^\s*export\s+default\s+/m, 'const __default = ')
        .replace(/^\s*export\s*\{[^}]*\};?\s*$/m, '');
      new vm.Script(body, { filename: rel });
      ok('js (ES-модуль): ' + rel);
    } else {
      new vm.Script(src, { filename: rel });
      ok('js: ' + rel);
    }
  } catch (e) { bad('синтаксис ' + rel + ': ' + e.message); }
}
for (const file of walk(ROOT, n => n.endsWith('.json') || n.endsWith('.jsonc'))) {
  const rel = path.relative(ROOT, file);
  try { JSON.parse(fs.readFileSync(file, 'utf8')); ok('json: ' + rel); }
  catch (e) { bad('json ' + rel + ': ' + e.message); }
}

/* ---------- 3. архив ---------- */
head('АРХИВ ПАМЯТИ');
let archive = null, index = null;
try {
  archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-archive.json.gz'))).toString('utf8'));
  const rows = archive.messages || [];
  const her = rows.filter(r => r[0] === 'assistant').length;
  const his = rows.filter(r => r[0] === 'user').length;
  const withExt = rows.filter(r => r[3] !== undefined).length;
  let oldest = Infinity, newest = 0;
  for (const r of rows) { if (r[1] > 0) { if (r[1] < oldest) oldest = r[1]; if (r[1] > newest) newest = r[1]; } }
  const d = (ts) => new Date(ts).toISOString().slice(0, 10);
  ok('сообщений: ' + rows.length.toLocaleString('ru-RU') + ' (она ' + her.toLocaleString('ru-RU') + ', он ' + his.toLocaleString('ru-RU') + ')');
  ok('период: ' + d(oldest) + ' — ' + d(newest));
  if (withExt === rows.length) ok('у всех сообщений есть id из Telegram (дубликаты не схлопываются)');
  else warn('без id: ' + (rows.length - withExt));
  if (rows.length !== archive.count) bad('count в файле (' + archive.count + ') не совпадает со списком (' + rows.length + ')');
  else ok('count совпадает');
  if (rows.length < 200000) bad('сообщений слишком мало: ' + rows.length);
} catch (e) { bad('не прочитать архив: ' + e.message); }

/* ---------- 4. индекс и его согласованность ---------- */
head('ИНДЕКС ПАМЯТИ');
try {
  index = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-index.json.gz'))).toString('utf8'));
  const terms = Object.keys(index.terms || {});
  let postings = 0;
  for (const t of terms) postings += index.terms[t].length;
  ok('термов: ' + terms.length.toLocaleString('ru-RU') + ', ссылок: ' + postings.toLocaleString('ru-RU'));
  if (terms.length < 10000) bad('термов мало — индекс пустой или битый');
  if (index.maxPostings !== 1500) warn('maxPostings = ' + index.maxPostings);

  // ГЛАВНАЯ проверка: основы из живых вопросов должны быть в индексе
  const probes = ['помнишь, как мы поссорились', 'как мы познакомились', 'я обиделась', 'готовился к экзамену', 'сырники', 'лошадь', 'тренировка', 'голова болит'];
  let miss = 0;
  for (const q of probes) {
    const found = MashaSearch.extractKeywords(q).filter(t => {
      const vars = [t].concat(MashaSearch.termVariants(t));
      return vars.some(v => index.terms[v]);
    });
    const kws = MashaSearch.extractKeywords(q);
    if (!kws.length) { warn('вопрос без ключевых слов: ' + q); continue; }
    if (!found.length) { bad('индекс НЕ находит: «' + q + '» (слова: ' + kws.join(', ') + ')'); miss++; }
    else ok('«' + q + '» → ' + found.join(', '));
  }

  // согласованность: 3000 случайных сообщений — их основы должны быть в индексе
  if (archive && archive.messages) {
    const rows = archive.messages;
    let checked = 0, absent = 0;
    const step = Math.max(1, Math.floor(rows.length / 3000));
    for (let i = 0; i < rows.length && checked < 3000; i += step) {
      const text = String(rows[i][2] || '');
      if (!text || text.startsWith('[')) continue;
      checked++;
      const kws = MashaSearch.extractKeywords(text);
      if (!kws.length) continue;
      const hit = kws.some(t => index.terms[t] || MashaSearch.termVariants(t).some(v => index.terms[v]));
      if (!hit) absent++;
    }
    const pctBad = 100 * absent / Math.max(1, checked);
    if (pctBad > 5) bad('индекс не покрывает сообщения: ' + pctBad.toFixed(1) + '% без совпадений (индекс собран другим алгоритмом)');
    else ok('индекс покрывает архив: без совпадений ' + pctBad.toFixed(1) + '% из ' + checked + ' проверенных');
  }
} catch (e) { bad('не прочитать индекс: ' + e.message); }

/* ---------- 5. приложение ---------- */
head('ПРИЛОЖЕНИЕ (index.html)');
try {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (blocks.length !== 1) bad('inline-скриптов: ' + blocks.length + ' (ожидался 1)');
  else ok('inline-скрипт один, ' + blocks[0].length + ' символов');

  const names = [...blocks[0].matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) bad('дублирующиеся функции: ' + dupes.join(', '));
  else ok('функций: ' + names.length + ', дубликатов нет');

  const handlers = [...new Set([...html.matchAll(/on(?:click|change|input)="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]))];
  const missing = handlers.filter(h => !names.includes(h));
  if (missing.length) bad('обработчики без функции: ' + missing.join(', '));
  else ok('обработчиков: ' + handlers.length + ', все определены');

  const pv = /const PROMPT_VERSION = (\d+)/.exec(blocks[0]);
  const bv = /const BUILD = (\d+)/.exec(blocks[0]);
  if (!pv || !bv) bad('нет PROMPT_VERSION или BUILD');
  else ok('версия промпта ' + pv[1] + ', сборка ' + bv[1]);

  const dp = /const DEFAULT_PROMPT = `([\s\S]*?)`;/.exec(blocks[0]);
  if (!dp) bad('не найден DEFAULT_PROMPT');
  else {
    const prompt = dp[1];
    ok('промпт: ' + prompt.split('\n').length + ' строк, ~' + Math.ceil(prompt.length / 3.5) + ' токенов');
    for (const [label, rx] of [['имя Маша', /Маша/], ['легенда про Вику из Дайвинчика', /Викой|Вика/], ['её реакции из архива', /КАК ТЫ РЕАГИРУЕШЬ/], ['«-_-»', /-_-/], ['серии сообщений', /ДВУМЯ сообщениями/], ['запрет «чё»', /чё/i], ['блок памяти', /ПАМЯТЬ/]]) {
      if (rx.test(prompt)) ok('промпт содержит: ' + label);
      else bad('в промпте нет: ' + label);
    }
  }
  for (const id of ['chat', 'input', 'offline-banner', 'server-banner', 'memory-stats', 'endpoints-input', 'archive-progress', 'who-modal']) {
    if (html.includes('id="' + id + '"')) ok('элемент #' + id);
    else bad('нет элемента #' + id);
  }
  // редактор промпта убран из настроек намеренно — промпт обновляется сборкой
  if (!html.includes('id="prompt"')) ok('промпт-редактор убран из настроек (по просьбе)');
  else warn('в настройках снова появился редактор промпта');
} catch (e) { bad('index.html: ' + e.message); }

/* ---------- 6. адреса релея ---------- */
head('АДРЕСА РЕЛЕЯ');
try {
  const cfg = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-apk.yml'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const endpoints = [...cfg.matchAll(/'(https?:\/\/[^']+)'/g)].map(m => m[1]);
  if (!endpoints.length) bad('в js/config.js нет адресов');
  else ok('в config.js: ' + endpoints.join(', '));
  for (const url of endpoints) {
    const host = new URL(url).host;
    if (!html.includes(host)) warn('адрес ' + host + ' отсутствует в index.html (запасной список)');
    else if (!wf.includes(host) && !host.includes('workers.dev')) warn('адрес ' + host + ' отсутствует в workflow');
  }
  if (workflowHasDefaults(wf, endpoints)) ok('workflow содержит те же адреса');
} catch (e) { bad('адреса: ' + e.message); }
function workflowHasDefaults(wf, endpoints) {
  return endpoints.every(u => wf.includes(new URL(u).host));
}

/* ---------- 7. готовность к APK ---------- */
head('ГОТОВНОСТЬ К СБОРКЕ APK');
if (archive && archive.messages && archive.messages.length > 200000) ok('архив внутри соберётся в APK');
else bad('архив не готов — APK будет без памяти');
for (const f of ['index.html', 'sw.js', 'manifest.json']) {
  if (fs.existsSync(path.join(ROOT, f))) ok('в APK уйдёт ' + f); else bad('нет ' + f);
}
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-apk.yml'), 'utf8');
if (wf.includes('masha-archive.json.gz') || wf.includes('archive/*.gz')) ok('workflow копирует архив в www/archive');
else bad('workflow не копирует архив');

/* ---------- итог ---------- */
console.log('\n' + '═'.repeat(50));
console.log('  Проверок: ' + checks + ' | проблем: ' + problems + ' | предупреждений: ' + warns);
console.log('  Вердикт: ' + (problems ? 'ЕСТЬ ПРОБЛЕМЫ — см. ✖ выше' : 'всё в порядке ✓'));
console.log('═'.repeat(50));
process.exitCode = problems ? 1 : 0;
