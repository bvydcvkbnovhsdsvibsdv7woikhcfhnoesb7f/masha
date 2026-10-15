#!/usr/bin/env node
/**
 * rebuild-index.mjs — пересобрать индекс ключевых слов по готовому архиву.
 *
 *   node tools/rebuild-index.mjs
 *   node tools/rebuild-index.mjs --archive archive/masha-archive.json.gz --out archive/masha-index.json.gz
 *
 * Нужен, когда меняется алгоритм стемминга: старый индекс перестаёт совпадать
 * с новыми запросами («поссорили» против «поссор»), и память «не находит» воспоминания.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MashaImport = require(path.join(ROOT, 'js', 'import-manager.js'));
const MashaSearch = require(path.join(ROOT, 'js', 'search-engine.js'));

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const archivePath = path.resolve(arg('--archive', path.join(ROOT, 'archive', 'masha-archive.json.gz')));
const outPath = path.resolve(arg('--out', path.join(ROOT, 'archive', 'masha-index.json.gz')));
const maxPostings = parseInt(arg('--max-postings', '1500'), 10) || 1500;
const plain = args.includes('--plain');

if (!fs.existsSync(archivePath)) {
  console.error('✖ нет архива: ' + archivePath);
  process.exit(1);
}

console.log('Читаю ' + path.basename(archivePath) + ' …');
const raw = fs.readFileSync(archivePath);
const json = JSON.parse(/\.gz$/i.test(archivePath) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
const rows = json.messages || [];
console.log('Сообщений: ' + rows.length.toLocaleString('ru-RU'));

const t0 = Date.now();
const index = MashaImport.buildIndex(rows, { maxPostings: maxPostings });
const terms = Object.keys(index.terms);
let postings = 0;
for (const t of terms) postings += index.terms[t].length;

const text = JSON.stringify(index);
if (plain) fs.writeFileSync(outPath.replace(/\.gz$/i, ''), text, 'utf8');
else fs.writeFileSync(outPath, zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));

console.log('Готово за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с');
console.log('  термов: ' + terms.length.toLocaleString('ru-RU'));
console.log('  ссылок: ' + postings.toLocaleString('ru-RU'));
console.log('  файл:   ' + outPath + ' (' + (fs.statSync(outPath).size / 1048576).toFixed(2) + ' МБ)');

// Контроль: находим ли типичные вопросы
console.log('\nПроверка на живых вопросах:');
for (const q of ['помнишь, как мы поссорились', 'как мы познакомились', 'я обиделась тогда', 'готовился к экзамену', 'сырники', 'лошадь']) {
  const kw = MashaSearch.extractKeywords(q);
  const found = [];
  for (const term of kw) {
    const vars = [term].concat(MashaSearch.termVariants(term));
    for (const v of vars) if (index.terms[v]) { found.push(v); break; }
  }
  console.log('  «' + q + '» → слова: ' + (kw.join(', ') || '—') + ' | найдено в индексе: ' + (found.length ? found.join(', ') : 'НИЧЕГО'));
}
