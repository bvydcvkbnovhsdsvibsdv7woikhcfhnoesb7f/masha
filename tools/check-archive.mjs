#!/usr/bin/env node
/**
 * check-archive.mjs — проверить память «Маши» на собранном архиве.
 *
 *   node tools/check-archive.mjs
 *   node tools/check-archive.mjs --ask "помнишь, как мы поссорились" --ask "кот"
 *   node tools/check-archive.mjs --max 50000        (быстрая проверка на части архива)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MashaMemory = require(path.join(ROOT, 'js', 'memory-db.js'));
const MashaSearch = require(path.join(ROOT, 'js', 'search-engine.js'));
const { FakeIndexedDB, IDBKeyRange } = await import(pathToFileURL(path.join(ROOT, 'test', 'fake-idb.mjs')).href);

const DEFAULT_QUERIES = [
  'помнишь, как мы поссорились',
  'как дела с тренировками',
  'у меня болит голова',
  'скучаю по тебе',
  'кот',
  'сырники',
  'ты меня любишь'
];

function parseArgs(argv) {
  const o = {
    archive: path.join(ROOT, 'archive', 'masha-archive.json.gz'),
    index: path.join(ROOT, 'archive', 'masha-index.json.gz'),
    ask: [], limit: 2, max: 0, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--archive' || a === '-a') o.archive = argv[++i];
    else if (a === '--index' || a === '-i') o.index = argv[++i];
    else if (a === '--ask') o.ask.push(argv[++i]);
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 2;
    else if (a === '--max') o.max = parseInt(argv[++i], 10) || 0;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error('файл не найден: ' + file);
  const buf = fs.readFileSync(file);
  return JSON.parse(/\.gz$/i.test(file) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8'));
}

function short(s, n = 80) {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('Использование: node tools/check-archive.mjs [--archive файл] [--index файл] [--ask "запрос"]... [--limit N] [--max N]');
    return 0;
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Проверка памяти «Маши»');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const archive = readJson(o.archive);
  let rows = archive.messages || [];
  const total = archive.count || rows.length;
  if (o.max > 0) rows = rows.slice(0, o.max);
  const messages = rows.map(r => ({ role: r[0], ts: r[1], content: r[2], extId: r[3] !== undefined ? String(r[3]) : '' }));

  console.log('Архив:            ' + path.basename(o.archive) + ' — ' + total.toLocaleString('ru-RU') + ' сообщений'
    + (rows.length !== total ? ' (проверяю первые ' + rows.length.toLocaleString('ru-RU') + ')' : ''));

  const db = MashaMemory.create({ indexedDB: new FakeIndexedDB(), IDBKeyRange, name: 'check_' + Date.now() });
  const hasIndex = fs.existsSync(o.index);
  const t0 = Date.now();
  const stats = await db.importMessages(messages, { source: 'archive', buildIndex: !hasIndex });
  console.log('Импорт:           ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с (вставлено ' + stats.inserted.toLocaleString('ru-RU') + ', дубликатов ' + stats.duplicates + ')');

  if (hasIndex) {
    const t1 = Date.now();
    const loaded = await db.loadIndex(readJson(o.index));
    console.log('Готовый индекс:   ' + loaded.terms.toLocaleString('ru-RU') + ' термов за ' + ((Date.now() - t1) / 1000).toFixed(1) + ' с');
  }

  const st = await db.getStats();
  console.log('В базе:           ' + st.messages.toLocaleString('ru-RU') + ' сообщений, ' + st.terms.toLocaleString('ru-RU') + ' термов');
  console.log('Период:           ' + (MashaSearch.formatDate(st.oldest) || '—') + ' — ' + (MashaSearch.formatDate(st.newest) || '—'));

  const again = await db.importMessages(messages, { source: 'archive', buildIndex: false });
  console.log('Повторный импорт: вставлено ' + again.inserted + ', дубликатов ' + again.duplicates.toLocaleString('ru-RU')
    + (again.inserted === 0 ? ' → дублей нет ✓' : ' → ВНИМАНИЕ, дубли!'));

  console.log('\n──── Что Маша вспомнит ────');
  for (const q of (o.ask.length ? o.ask : DEFAULT_QUERIES)) {
    const r = await db.recall(q, { episodeLimit: o.limit, radius: 1 });
    console.log('\n▸ «' + q + '»  (' + r.matched.toLocaleString('ru-RU') + ' совпадений, ' + r.tookMs + ' мс)');
    if (!r.episodes.length) { console.log('   — ничего не нашлось'); continue; }
    for (const ep of r.episodes) {
      console.log('   [' + (MashaSearch.formatDate(ep.ts) || 'без даты') + ']');
      for (const m of ep.items.slice(0, 4)) {
        console.log('     ' + (m.role === 'assistant' ? 'она' : 'он ') + ': ' + short(m.content));
      }
    }
    const block = MashaSearch.buildContextBlock(r.episodes, { maxChars: 3000 });
    console.log('   → в промпт уйдёт ' + block.length + ' символов (~' + MashaSearch.estimateTokens(block) + ' токенов)');
  }
  console.log('\nГотово.');
  return 0;
}

main().then(c => { process.exitCode = c; }).catch(e => { console.error('✖ Ошибка: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
