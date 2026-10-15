#!/usr/bin/env node
/**
 * build-archive.mjs — собрать память «Маши» из JSON-файлов переписки.
 *
 *   node tools/build-archive.mjs --in chat1.json chat2.json \
 *        --out archive/masha-archive.json.gz --index archive/masha-index.json.gz
 *
 * Что делает:
 *   1) читает каждый файл и определяет формат (Telegram personal_chat, Qwen, {messages}, массив);
 *   2) для Telegram сам понимает, кто «она» (собеседник чата), ник может меняться;
 *   3) убирает точные повторы (по id сообщения, иначе по роль+время+текст);
 *   4) сортирует по времени и пишет компактный архив [[role, ts, content, id], ...];
 *   5) строит индекс ключевых слов, чтобы телефон не строил его сам.
 *
 * Флаги: --plain (без gzip), --max-postings N, --quiet, --help
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

const HELP = `
Сборка архива памяти «Маши»

  node tools/build-archive.mjs --in <файлы...> [--out <файл>] [--index <файл>] [--plain] [--quiet]

  --in      JSON-файлы переписки (Telegram result.json, Qwen-экспорт, {messages:[...]}, массивы)
  --out     куда положить архив   (по умолчанию archive/masha-archive.json.gz)
  --index   куда положить индекс  (по умолчанию archive/masha-index.json.gz)
  --plain   писать .json вместо .gz
  --max-postings  лимит ссылок на терм (по умолчанию 1500)

Пример:
  node tools/build-archive.mjs --in "C:\\...\\chat1.json" "C:\\...\\chat2.json"
`;

function parseArgs(argv) {
  const opts = { inputs: [], out: 'archive/masha-archive.json.gz', index: 'archive/masha-index.json.gz', plain: false, quiet: false, help: false, maxPostings: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in' || a === '-i') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.inputs.push(argv[++i]); }
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--index') opts.index = argv[++i];
    else if (a === '--plain') opts.plain = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--max-postings') opts.maxPostings = parseInt(argv[++i], 10) || 1500;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function humanSize(bytes) {
  if (bytes > 1048576) return (bytes / 1048576).toFixed(2) + ' МБ';
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return bytes + ' Б';
}

function fmtDate(ts) {
  if (!(ts > 0)) return '—';
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' : '') + n;
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function writeOut(absPath, json, plain) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (plain) fs.writeFileSync(absPath, json, 'utf8');
  else fs.writeFileSync(absPath, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
}

function resolveOut(file, plain) {
  const abs = path.resolve(file);
  return plain ? abs.replace(/\.gz$/i, '') : abs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.inputs.length) { process.stdout.write(HELP); return opts.inputs.length ? 0 : 2; }

  const all = [];
  const sources = [];
  const seen = new Set();
  let total = 0, skipped = 0, duplicates = 0, service = 0;
  const warnings = [];
  const errors = [];
  const started = Date.now();

  if (!opts.quiet) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Сборка памяти «Маши»');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  for (const file of opts.inputs) {
    const name = path.basename(file);
    try {
      if (!fs.existsSync(file)) throw new Error('файл не найден');
      const raw = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(raw);
      const result = MashaImport.normalizeArchive(json, { source: name });
      if (result.format === 'unknown') throw new Error('формат не распознан');
      if (result.ambiguous) throw new Error('не понять, кто из участников «она» — укажи вручную в приложении');

      total += result.total;
      skipped += result.skipped;
      service += result.serviceSkipped || 0;
      for (const w of result.warnings) if (!warnings.includes(w)) warnings.push(w);

      const he = result.messages.filter(m => m.role === 'user').length;
      const she = result.messages.filter(m => m.role === 'assistant').length;

      let kept = 0;
      for (const msg of result.messages) {
        const key = msg.role + '|' + msg.ts + '|' + msg.content + (msg.extId ? '|#' + msg.extId : '');
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        all.push(msg);
        kept++;
      }
      if (!sources.includes(name)) sources.push(name);
      if (!opts.quiet) console.log(`  ✓ ${name}  ${result.format}  ${kept} сообщ.  (он: ${he}, она: ${she})`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      errors.push(`${name}: ${msg}`);
      if (!opts.quiet) console.log(`  ✖ ${name}  ${msg}`);
    }
  }

  if (!all.length) {
    console.error('\n✖ Ни одного сообщения не собрано — архив не создан.');
    for (const e of errors) console.error('   ' + e);
    return 1;
  }

  const archive = MashaImport.buildArchive(all, { sources });
  const archiveJson = JSON.stringify(archive);
  const outPath = resolveOut(opts.out, opts.plain);
  writeOut(outPath, archiveJson, opts.plain);

  const index = MashaImport.buildIndex(archive.messages, { maxPostings: opts.maxPostings });
  const indexJson = JSON.stringify(index);
  const indexPath = resolveOut(opts.index, opts.plain);
  writeOut(indexPath, indexJson, opts.plain);

  const terms = Object.keys(index.terms);
  let postings = 0;
  for (const t of terms) postings += index.terms[t].length;

  const he = all.filter(m => m.role === 'user').length;
  const she = all.filter(m => m.role === 'assistant').length;
  let oldest = 0, newest = 0;
  for (const m of all) {
    if (!(m.ts > 0)) continue;
    if (!oldest || m.ts < oldest) oldest = m.ts;
    if (m.ts > newest) newest = m.ts;
  }

  if (!opts.quiet) {
    console.log('');
    console.log(`Файлов принято:     ${sources.length} из ${opts.inputs.length}`);
    console.log(`Сообщений в архиве: ${archive.count}`);
    console.log(`  он:               ${he}`);
    console.log(`  она:              ${she}`);
    console.log(`Прочитано записей:  ${total}, служебных: ${service}, пустых: ${skipped}, повторов убрано: ${duplicates}`);
    console.log(`Период:             ${fmtDate(oldest)} — ${fmtDate(newest)}`);
    console.log(`Источники:          ${sources.join(', ')}`);
    console.log('');
    console.log(`Архив:  ${outPath}`);
    console.log(`        ${humanSize(Buffer.byteLength(archiveJson))} JSON${opts.plain ? '' : ' → ' + humanSize(fs.statSync(outPath).size) + ' gzip'}`);
    console.log(`Индекс: ${indexPath}`);
    console.log(`        ${humanSize(Buffer.byteLength(indexJson))} JSON${opts.plain ? '' : ' → ' + humanSize(fs.statSync(indexPath).size) + ' gzip'}, термов: ${terms.length}, ссылок: ${postings}`);
    console.log(`Готово за ${((Date.now() - started) / 1000).toFixed(1)} с.`);
    if (warnings.length) {
      console.log('');
      console.log('Предупреждения:');
      for (const w of warnings.slice(0, 5)) console.log('  • ' + w);
    }
  }
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(err => {
  console.error('✖ Ошибка: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
