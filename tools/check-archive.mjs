#!/usr/bin/env node
/**
 * check-archive.mjs — проверка, что архив «Маши» реально работает как память.
 *
 * Загружает архив (+ готовый индекс), кладёт в IndexedDB (in-memory шим),
 * прогоняет несколько живых запросов и показывает, что Маша «вспомнит».
 *
 * Запуск:
 *   node tools/check-archive.mjs --archive archive/masha-archive.json.gz \
 *        --index archive/masha-index.json.gz
 *   node tools/check-archive.mjs --archive archive/masha-archive.json.gz \
 *        --ask "помнишь, как мы поссорились" --ask "кот"
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
const MashaMemory = require(path.join(ROOT, 'js', 'memory-db.js'));
const MashaSearch = require(path.join(ROOT, 'js', 'search-engine.js'));

const { FakeIndexedDB, IDBKeyRange } = await import(
  'file://' + path.join(ROOT, 'test', 'fake-idb.mjs').replace(/\\/g, '/')
);

const DEFAULT_QUERIES = [
  'помнишь, как мы поссорились',
  'как дела с колледжем и парами',
  'у меня болит голова',
  'скучаю по тебе',
  'кот',
  'день рождения',
  'сырники',
  'ты меня любишь'
];

function parseArgs(argv) {
  const opts = { archive: '', index: '', ask: [], limit: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--archive' || a === '-a') opts.archive = argv[++i];
    else if (a === '--index' || a === '-i') opts.index = argv[++i];
    else if (a === '--ask') opts.ask.push(argv[++i]);
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || 2;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function readJson(file) {
  const buf = fs.readFileSync(file);
  const text = /\.gz$/i.test(file) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(text);
}

function fmtDate(ts) {
  return MashaSearch.formatDate(ts) || '—';
}

function short(text, n = 90) {
  const s = String(text || '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.archive) {
    console.log('Использование: node tools/check-archive.mjs --archive <файл> [--index <файл>] [--ask "запрос"]...');
    return opts.archive ? 0 : 2;
  }
  if (!fs.existsSync(opts.archive)) {
    console.error('✖ Архив не найден: ' + opts.archive);
    return 2;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Проверка памяти «Маши»');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const t0 = Date.now();
  const archive = readJson(opts.archive);
  const messages = (archive.messages || []).map((row) => ({
    role: row[0],
    ts: row[1],
    content: row[2],
    extId: row[3] !== undefined ? String(row[3]) : ''
  }));
  console.log(`Архив:            ${path.basename(opts.archive)} — ${messages.length.toLocaleString('ru-RU')} сообщений (${((Date.now() - t0) / 1000).toFixed(1)} с на чтение)`);

  const db = MashaMemory.create({
    indexedDB: new FakeIndexedDB(),
    IDBKeyRange,
    name: 'check_' + Date.now()
  });

  const t1 = Date.now();
  let lastLog = 0;
  const stats = await db.importMessages(messages, {
    source: 'archive',
    buildIndex: !opts.index,
    onProgress: (done, total) => {
      if (done - lastLog >= 50000) { lastLog = done; process.stdout.write(`  … ${done.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}\r`); }
    }
  });
  console.log(`Импорт:           ${((Date.now() - t1) / 1000).toFixed(1)} с (вставлено ${stats.inserted.toLocaleString('ru-RU')}, дубликатов ${stats.duplicates})`);

  if (opts.index) {
    const t2 = Date.now();
    const index = readJson(opts.index);
    const loaded = await db.loadIndex(index);
    console.log(`Готовый индекс:   ${loaded.terms.toLocaleString('ru-RU')} термов, ${loaded.postings.toLocaleString('ru-RU')} постингов за ${((Date.now() - t2) / 1000).toFixed(1)} с`);
  }

  const st = await db.getStats();
  console.log(`В базе:           ${st.messages.toLocaleString('ru-RU')} сообщений, ${st.terms.toLocaleString('ru-RU')} термов`);
  console.log(`Период:           ${fmtDate(st.oldest)} — ${fmtDate(st.newest)}`);
  console.log(`Источники:        ${(st.sources || []).join(', ')}`);

  // повторный импорт — проверка идемпотентности
  const again = await db.importMessages(messages, { source: 'archive', buildIndex: false });
  console.log(`Повторный импорт: вставлено ${again.inserted}, дубликатов ${again.duplicates.toLocaleString('ru-RU')} → ${again.inserted === 0 ? 'дубликатов нет, всё ок ✓' : 'ВНИМАНИЕ: дубли!'}`);

  const queries = opts.ask.length ? opts.ask : DEFAULT_QUERIES;
  console.log('\n──── Что Маша вспомнит ────');
  for (const q of queries) {
    const r = await db.recall(q, { episodeLimit: opts.limit, radius: 1 });
    console.log(`\n▸ «${q}»  (${r.matched.toLocaleString('ru-RU')} совпадений, ${r.tookMs} мс)`);
    if (!r.episodes.length) { console.log('   — ничего не нашлось'); continue; }
    for (const ep of r.episodes) {
      const date = fmtDate(ep.ts);
      const lines = ep.items.slice(0, 4).map((m) => `     ${m.role === 'assistant' ? 'она' : 'он '}: ${short(m.content)}`);
      console.log(`   [${date}]`);
      console.log(lines.join('\n'));
    }
    const block = MashaSearch.buildContextBlock(r.episodes, { maxChars: 3000 });
    console.log(`   → в промпт уйдёт ${block.length} символов (~${MashaSearch.estimateTokens(block)} токенов)`);
  }

  console.log('\nГотово.');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error('✖ Ошибка: ' + (err && err.stack ? err.stack : err)); process.exitCode = 1; });
