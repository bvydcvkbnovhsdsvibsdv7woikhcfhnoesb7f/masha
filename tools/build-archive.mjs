#!/usr/bin/env node
/*
 * build-archive.mjs — сборка переносимого архива «Маша» на Node (без зависимостей).
 *
 * Использование:
 *   node tools/build-archive.mjs --in a.json b.json [--out archive/masha-archive.json.gz]
 *                                [--index archive/masha-index.json.gz] [--plain]
 *
 * Что делает:
 *   - читает входные JSON (любой из 4 форматов: array / messages+Telegram / qwen / export);
 *   - нормализует через js/import-manager.js, склеивает, сортирует по ts, присваивает seq;
 *   - пишет gzip-архив {"v":1,"builtAt":...,"count":N,"sources":[...],"messages":[[role,ts,content],...]};
 *   - пишет индекс {"v":1,"maxPostings":1500,"terms":{"терм":[seq,...]}};
 *   - печатает статистику (сообщения, роли, даты, размеры, топ-20 термов, время).
 *
 * Builtins: node:fs, node:zlib, node:path, node:module, node:url.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ модули */

const MashaImport = require(path.join(PROJECT_ROOT, 'js', 'import-manager.js'));

// Если есть js/search-engine.js (владелец — агент B), используем его нормализацию термов:
// тогда термы индекса совпадут с термами поиска в приложении.
try {
  const engine = require(path.join(PROJECT_ROOT, 'js', 'search-engine.js'));
  if (engine && typeof engine.extractKeywords === 'function') MashaImport.setSearchEngine(engine);
} catch (e) { /* модуль ещё не написан — сработает встроенный разбор */ }

/* -------------------------------------------------------------------- args */

function parseArgs(argv) {
  const opts = { inputs: [], out: 'archive/masha-archive.json.gz', index: 'archive/masha-index.json.gz', plain: false, maxPostings: 1500, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in' || a === '-i') {
      i++;
      while (i < argv.length && !argv[i].startsWith('--')) { opts.inputs.push(argv[i]); i++; }
      i--;
    } else if (a === '--out' || a === '-o') { opts.out = argv[++i]; }
    else if (a === '--index' || a === '-x') { opts.index = argv[++i]; }
    else if (a === '--max-postings') { opts.maxPostings = parseInt(argv[++i], 10) || 1500; }
    else if (a === '--plain') { opts.plain = true; }
    else if (a === '--quiet' || a === '-q') { opts.quiet = true; }
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else if (!a.startsWith('-')) { opts.inputs.push(a); }
    else { throw new Error('Неизвестный флаг: ' + a); }
  }
  return opts;
}

const HELP = `
Сборка архива переписки «Маша».

  node tools/build-archive.mjs --in <файлы...> [--out <файл>] [--index <файл>] [--plain]

  --in,  -i   входные JSON (можно несколько; поддерживаются .json и .json.gz)
  --out, -o   куда писать архив (по умолчанию archive/masha-archive.json.gz)
  --index,-x  куда писать индекс термов (по умолчанию archive/masha-index.json.gz)
  --plain     не сжимать (обычный .json; расширение .gz убирается)
  --max-postings N  сколько seq хранить на терм (по умолчанию 1500)
  --quiet, -q без подробного вывода
  --help,  -h эта справка

Форматы определяются автоматически: array, messages (Telegram result.json), qwen, export.
`;

/* ------------------------------------------------------------------ утилиты */

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(2) + ' МБ';
}

function pad(str, n) {
  str = String(str);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function readInput(file) {
  const buf = fs.readFileSync(file);
  const name = path.basename(file);
  if (/\.(json\.)?gz$/i.test(name) || /\.bin$/i.test(name)) {
    if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

function fmtDate(ts) {
  if (!(ts > 0)) return '—';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (!opts.inputs.length) {
    process.stdout.write(HELP);
    console.error('✖ Не указаны входные файлы (--in)');
    return 2;
  }

  const started = Date.now();
  const all = [];
  const sources = [];
  const formatCounts = {};
  const warnings = [];
  const errors = [];
  let total = 0;
  let skipped = 0;
  let duplicates = 0;
  const seen = new Set();   // role|ts|content — те же правила, что в приложении

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Сборка архива «Маша»');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const engineInfo = MashaImport.termEngine();
  console.log(`Движок термов: ${engineInfo.reason}`);
  console.log('');

  for (const file of opts.inputs) {
    const name = path.basename(file);
    try {
      if (!fs.existsSync(file)) throw new Error('файл не найден');
      const text = readInput(file);
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('не удалось разобрать JSON (' + e.message + ')');
      }
      const result = MashaImport.normalizeArchive(json, { source: name });
      formatCounts[result.format] = (formatCounts[result.format] || 0) + 1;
      total += result.total;
      skipped += result.skipped;
      for (const w of result.warnings) if (!warnings.includes(w)) warnings.push(w);
      if (result.format === 'unknown') throw new Error('формат архива не распознан');
      // ВАЖНО: не all.push(...result.messages) — на 170к сообщений спред
      // переполняет стек вызовов («Maximum call stack size exceeded»).
      for (const msg of result.messages) {
        // Дедупликация по id исходного сообщения (если он есть) — иначе
        // одинаковые реплики в одну секунду схлопывались бы зря.
        const key = msg.role + '|' + msg.ts + '|' + msg.content + (msg.extId ? '|#' + msg.extId : '');
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        all.push(msg);
      }
      if (!sources.includes(name)) sources.push(name);
      const roles = countRoles(result.messages);
      console.log(`  ✓ ${pad(name, 34)} ${pad(result.format, 9)} ${pad(result.messages.length, 7)} сообщ.  (он: ${roles.user}, она: ${roles.assistant})`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      console.log(`  ✖ ${pad(name, 34)} ${msg}`);
    }
  }

  if (!all.length) {
    console.error('\n✖ Ни одного сообщения не собрано — архив не создан.');
    if (errors.length) for (const e of errors) console.error('   ' + e);
    return 1;
  }

  /* --- архив --- */
  const archive = MashaImport.buildArchive(all, { sources });
  const archiveJson = JSON.stringify(archive);
  const outPath = resolveOut(opts.out, opts.plain);
  writeOut(outPath, archiveJson, opts.plain);

  /* --- индекс --- */
  const index = MashaImport.buildIndex(archive.messages, { maxPostings: opts.maxPostings });
  const indexJson = JSON.stringify(index);
  const indexPath = resolveOut(opts.index, opts.plain);
  writeOut(indexPath, indexJson, opts.plain);

  /* --- статистика --- */
  const roles = countRoles(all);
  const terms = Object.keys(index.terms);
  let postings = 0;
  for (const t of terms) postings += index.terms[t].length;
  const top = terms
    .map((t) => [t, index.terms[t].length])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 20);

  // min/max циклом: Math.min(...tsList) на 265к элементов тоже роняет стек
  let oldest = 0;
  let newest = 0;
  for (const row of archive.messages) {
    const t = row[1];
    if (!(t > 0)) continue;
    if (!oldest || t < oldest) oldest = t;
    if (t > newest) newest = t;
  }

  console.log('');
  console.log('──── Итог ────');
  console.log(`Файлов принято:     ${sources.length} из ${opts.inputs.length}`);
  console.log(`Форматы:            ${Object.entries(formatCounts).map(([f, n]) => `${f}×${n}`).join(', ') || '—'}`);
  console.log(`Сообщений в архиве: ${archive.count}`);
  console.log(`  он (user):        ${roles.user}`);
  console.log(`  она (assistant):  ${roles.assistant}`);
  console.log(`Прочитано записей:  ${total}, пропущено: ${skipped}, повторов убрано: ${duplicates}`);
  console.log(`Период:             ${fmtDate(oldest)} — ${fmtDate(newest)}`);
  console.log(`Источники:          ${sources.join(', ')}`);
  console.log('');
  console.log(`Архив:  ${outPath}`);
  console.log(`        ${humanSize(Buffer.byteLength(archiveJson))} JSON${opts.plain ? '' : ` → ${humanSize(fs.statSync(outPath).size)} gzip`}`);
  console.log(`Индекс: ${indexPath}`);
  console.log(`        ${humanSize(Buffer.byteLength(indexJson))} JSON${opts.plain ? '' : ` → ${humanSize(fs.statSync(indexPath).size)} gzip`}, термов: ${terms.length}, постингов: ${postings} (лимит ${index.maxPostings}/терм)`);
  console.log('');
  console.log('Топ-20 термов:');
  console.log('  ' + top.map(([t, n]) => `${t}(${n})`).join('  '));
  if (warnings.length) {
    console.log('');
    console.log(`Предупреждения (${warnings.length}):`);
    for (const w of warnings.slice(0, 8)) console.log('  • ' + w);
  }
  if (errors.length) {
    console.log('');
    console.log(`Ошибки (${errors.length}):`);
    for (const e of errors) console.log('  • ' + e);
  }
  console.log('');
  console.log(`Готово за ${((Date.now() - started) / 1000).toFixed(2)} с.`);
  if (!MashaImport.termEngine().ok) {
    console.log('');
    console.log('⚠ ' + MashaImport.termEngine().reason);
    console.log('  Индекс получился приблизительным: термы могут не совпасть с поиском в приложении.');
  }
  return 0;
}

function countRoles(messages) {
  let user = 0;
  let assistant = 0;
  for (const m of messages) {
    if (m.role === 'user') user++;
    else if (m.role === 'assistant') assistant++;
  }
  return { user, assistant };
}

function resolveOut(file, plain) {
  const abs = path.resolve(file);
  return plain ? abs.replace(/\.gz$/i, '') : abs;
}

function writeOut(absPath, json, plain) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (plain) {
    fs.writeFileSync(absPath, json, 'utf8');
  } else {
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    fs.writeFileSync(absPath, gz);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error('✖ Ошибка: ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
