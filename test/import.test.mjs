/*
 * Тесты импорта архивов переписки (js/import-manager.js).
 * Запуск: & "<node>" --test test   (из корня проекта)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MashaImport = require('../js/import-manager.js');

// Если появится js/search-engine.js — тестируем связку с ним, если нет — встроенный fallback.
let MashaSearch = null;
try { MashaSearch = require('../js/search-engine.js'); } catch (e) { MashaSearch = null; }
if (MashaSearch) MashaImport.setSearchEngine(MashaSearch);

const REAL_FILE = 'C:\\Users\\Эдуард\\Downloads\\chat-export-1791699861271.json';

/* ------------------------------------------------------------------ helpers */

function fakeFile(name, text) {
  return {
    name,
    size: Buffer.byteLength(text, 'utf8'),
    type: 'application/json',
    _textCalls: 0,
    async text() { this._textCalls++; return text; },
    async arrayBuffer() { return new TextEncoder().encode(text).buffer; }
  };
}

function fakeGzipFile(name, text) {
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
  const bytes = new Uint8Array(gz);
  return {
    name,
    size: bytes.length,
    type: 'application/gzip',
    async text() { throw new Error('для .gz нельзя читать как текст'); },
    async arrayBuffer() { return bytes; }
  };
}

function fakeMemory() {
  const calls = [];
  return {
    calls,
    async importMessages(messages, opts) {
      calls.push({ messages, opts });
      if (opts && typeof opts.onProgress === 'function') opts.onProgress(messages.length, messages.length);
      return { inserted: messages.length, duplicates: 0, skipped: 0, terms: 7, durationMs: 3 };
    }
  };
}

function realFileLike() {
  const buf = fs.readFileSync(REAL_FILE);
  return {
    name: 'chat-export-1791699861271.json',
    size: buf.length,
    type: 'application/json',
    _textCalls: 0,
    async text() { this._textCalls++; return buf.toString('utf8'); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
  };
}

/* ------------------------------------------------------------ parseTimestamp */

test('parseTimestamp: unix sec, unix ms, ISO и DD.MM.YYYY HH:MM:SS', () => {
  const sec = 1789794958;
  assert.equal(MashaImport.parseTimestamp(sec), sec * 1000, 'unix секунды');
  assert.equal(MashaImport.parseTimestamp(sec * 1000), sec * 1000, 'unix миллисекунды');
  assert.equal(MashaImport.parseTimestamp(String(sec)), sec * 1000, 'числовая строка-секунды');

  assert.equal(MashaImport.parseTimestamp('2024-08-12T21:14:05Z'), Date.parse('2024-08-12T21:14:05Z'), 'ISO с Z');
  assert.equal(MashaImport.parseTimestamp('2024-08-12 21:14:05'), Date.parse('2024-08-12 21:14:05'), 'ISO с пробелом');
  assert.equal(MashaImport.parseTimestamp('2024-08-12'), Date.parse('2024-08-12'));

  const local = new Date(2024, 7, 12, 21, 14, 5).getTime();
  assert.equal(MashaImport.parseTimestamp('12.08.2024 21:14:05'), local, 'DD.MM.YYYY HH:MM:SS');
  assert.equal(MashaImport.parseTimestamp('12.08.2024 21:14'), new Date(2024, 7, 12, 21, 14, 0).getTime());
  assert.equal(MashaImport.parseTimestamp('12.08.2024'), new Date(2024, 7, 12, 0, 0, 0).getTime());

  assert.equal(MashaImport.parseTimestamp(0), 0);
  assert.equal(MashaImport.parseTimestamp(-5), 0);
  assert.equal(MashaImport.parseTimestamp(''), 0);
  assert.equal(MashaImport.parseTimestamp(null), 0);
  assert.equal(MashaImport.parseTimestamp(undefined), 0);
  assert.equal(MashaImport.parseTimestamp('не дата'), 0);
  assert.equal(MashaImport.parseTimestamp({}), 0);
});

/* -------------------------------------------------------- определение формата */

test('detectFormat: qwen / telegram / messages / array / export / unknown', () => {
  assert.equal(MashaImport.detectFormat([{ chat: { messages: [{ role: 'user', content: 'x' }] } }]), 'qwen');
  assert.equal(MashaImport.detectFormat({ chat: { history: { messages: { a: { role: 'user' } } } } }), 'qwen');

  assert.equal(MashaImport.detectFormat({ messages: [{ id: 1, type: 'message', from: 'Эдуард', date: '2024-08-12T21:14:05', text: 'привет' }] }), 'telegram');
  assert.equal(MashaImport.detectFormat({ messages: [{ role: 'user', content: 'a' }] }), 'messages');
  assert.equal(MashaImport.detectFormat({ messages: { a: { role: 'user', content: 'a' } } }), 'messages');
  assert.equal(MashaImport.detectFormat([{ role: 'user', content: 'a' }]), 'array');
  assert.equal(MashaImport.detectFormat({ v: 1, messages: [['user', 1, 'a']] }), 'export');
  assert.equal(MashaImport.detectFormat([['user', 1, 'a']]), 'export');
  assert.equal(MashaImport.detectFormat({ v: 1, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }), 'export');

  assert.equal(MashaImport.detectFormat('{ не json'), 'unknown');
  assert.equal(MashaImport.detectFormat(null), 'unknown');
  assert.equal(MashaImport.detectFormat(42), 'unknown');
  assert.equal(MashaImport.detectFormat({ foo: 1 }), 'unknown');
});

/* ------------------------------------------------------------------- роли */

test('роли: user/human/me/я/вы/Эдуард -> user, assistant/bot/ai/model/Маша -> assistant, иначе skip', () => {
  const asUser = ['user', 'human', 'me', 'Я', 'вы', 'Эдуард', 'eduard', 'USER'];
  const asAssistant = ['assistant', 'bot', 'ai', 'model', 'Маша', 'masha', 'Assistant'];
  for (const r of asUser) {
    const m = MashaImport.normalizeMessage({ role: r, content: 'текст', ts: 1 }, { format: 'array' });
    assert.ok(m, 'роль ' + r + ' должна распознаться');
    assert.equal(m.role, 'user', 'роль ' + r);
  }
  for (const r of asAssistant) {
    const m = MashaImport.normalizeMessage({ role: r, content: 'текст', ts: 1 }, { format: 'array' });
    assert.ok(m, 'роль ' + r + ' должна распознаться');
    assert.equal(m.role, 'assistant', 'роль ' + r);
  }
  for (const r of ['system', 'tool', 'unknown_guy', '']) {
    assert.equal(MashaImport.normalizeMessage({ role: r, content: 'текст', ts: 1 }, { format: 'array' }), null, 'роль ' + r + ' должна пропускаться');
  }
});

/* ------------------------------------------------------ формат array / messages */

test('array: маппинг полей, даты в 3 форматах, чистка', () => {
  const arr = [
    { role: 'user', content: 'привет', ts: 1699999999 },
    { role: 'human', text: 'как дела', timestamp: 1699999999000 },
    { from: 'me', message: 'ок', date: '12.08.2024 21:14:05' },
    { role: 'ai', content: 'всё хорошо' },
    { author: 'Маша', content: 'ага' },
    { role: 'system', content: 'игнор' },
    { role: 'unknown_guy', content: '??' },
    { role: 'user', content: '   ' }
  ];
  const res = MashaImport.normalizeArchive(arr, { source: 'arr.json' });
  assert.equal(res.format, 'array');
  assert.equal(res.total, 8);
  assert.equal(res.messages.length, 5);
  assert.equal(res.skipped, 3);
  assert.deepEqual(res.messages.map((m) => m.role), ['user', 'user', 'user', 'assistant', 'assistant']);
  assert.equal(res.messages[0].ts, 1699999999000);
  assert.match(res.messages[0].iso, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'iso: ' + res.messages[0].iso);
  assert.equal(res.messages[0].day, res.messages[0].iso.slice(0, 10), 'day — это дата из ts');
  assert.equal(res.messages[1].content, 'как дела');
  assert.equal(res.messages[2].content, 'ок');
  assert.equal(res.messages[3].ts, 0);
  assert.equal(res.messages[3].iso, '', 'ts=0 -> iso пустой');
  assert.equal(res.messages[3].day, '');
  assert.equal(res.messages[4].src, 'arr.json');
  assert.ok(res.warnings.length >= 1, 'должны быть предупреждения о мусоре');
  assert.ok(res.warnings.some((w) => /Неизвестная роль/.test(w)));
});

test('messages: {messages:[...]} и словарь id->сообщение', () => {
  const res = MashaImport.normalizeArchive({
    messages: [
      { role: 'user', content: 'раз', ts: 1700000000000 },
      { role: 'assistant', content: 'два', ts: 1700000060000 }
    ]
  }, { source: 'm.json' });
  assert.equal(res.format, 'messages');
  assert.equal(res.messages.length, 2);
  assert.equal(res.messages[1].content, 'два');
  assert.match(res.messages[1].iso, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  const dict = MashaImport.normalizeArchive({
    messages: { a: { role: 'user', content: 'раз' }, b: { role: 'Маша', content: 'два' } }
  }, {});
  assert.equal(dict.format, 'messages');
  assert.equal(dict.messages.length, 2);
  assert.equal(dict.messages[1].role, 'assistant');
});

test('telegram: type!=message пропускается, текст из массива фрагментов, фото -> [фото]', () => {
  const telegram = {
    name: 'Чат с Машей',
    type: 'personal_chat',
    messages: [
      { id: 1, type: 'message', date: '2024-08-12T21:14:05', from: 'Эдуард', from_id: 'user1', text: 'привет' },
      { id: 2, type: 'service', date: '2024-08-12T21:15:00', actor: 'Эдуард', action: 'join_group_by_link' },
      { id: 3, type: 'message', date: '2024-08-12T21:16:00', from: 'Маша', from_id: 'user2', text: ['смотри', ' как дела'] },
      { id: 4, type: 'message', date: '2024-08-12T21:17:00', from: 'Маша', text: [{ type: 'bold', text: 'жирный' }, { type: 'plain', text: ' текст' }] },
      { id: 5, type: 'message', date: '2024-08-12T21:18:00', from: 'Маша', photo: 'photos/y.jpg' },
      { id: 6, type: 'message', date: '2024-08-12T21:19:00', from: 'Маша', text: 'картинка', photo: 'photos/z.jpg' }
    ]
  };
  const res = MashaImport.normalizeArchive(telegram, { source: 'result.json' });
  assert.equal(res.format, 'telegram');
  assert.equal(res.total, 6);
  assert.equal(res.serviceSkipped, 1);
  assert.equal(res.messages.length, 5, 'сервисное сообщение не попадает в архив');
  assert.deepEqual(res.messages.map((m) => m.role), ['user', 'assistant', 'assistant', 'assistant', 'assistant']);
  assert.equal(res.messages[0].content, 'привет');
  assert.equal(res.messages[1].content, 'смотри как дела');
  assert.equal(res.messages[2].content, 'жирный текст');
  assert.equal(res.messages[3].content, '[фото]');
  assert.equal(res.messages[4].content, 'картинка');
  assert.ok(res.messages.every((m) => m.ts > 0));
});

test('export: {v,messages:[[role,ts,content]]} и {v,messages:[{...}]}', () => {
  const rows = MashaImport.normalizeArchive({ v: 1, messages: [['user', 1700000000000, 'привет'], ['assistant', 1700000060000, 'ага']] }, {});
  assert.equal(rows.format, 'export');
  assert.equal(rows.messages.length, 2);
  assert.equal(rows.messages[0].role, 'user');
  assert.equal(rows.messages[0].ts, 1700000000000);
  assert.equal(rows.messages[1].content, 'ага');

  const objs = MashaImport.normalizeArchive({ v: 1, messages: [{ role: 'user', content: 'а', ts: 1 }, { role: 'assistant', content: 'б', ts: 2 }] }, {});
  assert.equal(objs.format, 'export');
  assert.equal(objs.messages.length, 2);

  const rootArr = MashaImport.normalizeArchive([['user', 1, 'а'], ['assistant', 2, 'б']], {});
  assert.equal(rootArr.format, 'export');
  assert.equal(rootArr.messages.length, 2);
});

/* -------------------------------------------------------------- мусор/ошибки */

test('битый JSON и мусор не роняют процесс, warnings ограничены 20', () => {
  for (const junk of ['{ не json', '', null, undefined, 42, true, { foo: 1 }, {}, []]) {
    const res = MashaImport.normalizeArchive(junk, {});
    assert.equal(typeof res, 'object');
    assert.ok(Array.isArray(res.messages));
    assert.equal(res.messages.length, 0);
    assert.ok(res.warnings.length >= 1, 'для мусора нужен warning');
    assert.ok(res.warnings.length <= MashaImport.MAX_WARNINGS);
  }

  const many = [];
  for (let i = 0; i < 50; i++) many.push({ role: 'unknown_role_' + i, content: 'x', ts: 1 });
  const res = MashaImport.normalizeArchive(many, {});
  assert.equal(res.messages.length, 0);
  assert.equal(res.skipped, 50);
  assert.ok(res.warnings.length <= MashaImport.MAX_WARNINGS, 'предупреждений не больше 20, а не ' + res.warnings.length);
});

test('пустые сообщения пропускаются, вложения дают заглушку', () => {
  assert.equal(MashaImport.normalizeMessage({ role: 'user', content: '   ' }, { format: 'array' }), null);
  assert.equal(MashaImport.normalizeMessage({ role: 'user' }, { format: 'array' }), null);
  assert.equal(MashaImport.normalizeMessage(null, {}), null);

  const img = MashaImport.normalizeMessage({ role: 'user', content: '', files: [{ name: 'a.png', type: 'image/png' }] }, { format: 'qwen' });
  assert.equal(img.content, '[фото]');
  const doc = MashaImport.normalizeMessage({ role: 'user', content: '', files: [{ name: 'a.zip', type: 'application/zip' }] }, { format: 'qwen' });
  assert.equal(doc.content, '[файл]');
  const base64 = MashaImport.normalizeMessage({ role: 'user', content: 'data:image/png;base64,' + 'A'.repeat(400) }, { format: 'array' });
  assert.equal(base64.content, '[фото]', 'base64 не храним');
});

/* ------------------------------------------------------- реальный Qwen-экспорт */

test('РЕАЛЬНЫЙ ФАЙЛ chat-export-1791699861271.json: qwen, ровно 924 сообщения, 462 user, ts>0', () => {
  assert.ok(fs.existsSync(REAL_FILE), 'нет реального файла ' + REAL_FILE);
  const json = JSON.parse(fs.readFileSync(REAL_FILE, 'utf8'));

  assert.equal(MashaImport.detectFormat(json), 'qwen');

  const res = MashaImport.normalizeArchive(json, { source: 'chat-export-1791699861271.json' });
  assert.equal(res.format, 'qwen');
  assert.equal(res.total, 924);
  assert.equal(res.messages.length, 924, 'должно быть ровно 924 сообщения');
  assert.equal(res.messages.filter((m) => m.role === 'user').length, 462, 'ровно 462 сообщения с ролью user');
  assert.equal(res.messages.filter((m) => m.role === 'assistant').length, 462);
  assert.equal(res.messages.filter((m) => !(m.ts > 0)).length, 0, 'у всех сообщений ts>0');

  for (const m of res.messages) {
    assert.ok(m.content.length > 0, 'пустого контента быть не должно');
    assert.match(m.iso, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'iso: ' + m.iso);
    assert.match(m.day, /^\d{4}-\d{2}-\d{2}$/, 'day: ' + m.day);
    assert.equal(m.src, 'chat-export-1791699861271.json');
    assert.ok(m.ts >= 1789794958000 && m.ts <= 1791699730000, 'ts в диапазоне файла: ' + m.ts);
  }

  // content_list[phase:'answer'] подхватывается, картинки — заглушкой
  assert.ok(res.messages.some((m) => /Мне очень жаль/.test(m.content)), 'ответ из content_list должен попасть в архив');
  assert.equal(res.messages.filter((m) => m.content === '[фото]').length, 67);
  assert.ok(res.messages[0].content.indexOf('меня бросила девушка') !== -1);

  // порядок сообщений как в файле (для стабильных seq), ts неубывающий
  for (let i = 1; i < res.messages.length; i++) {
    assert.ok(res.messages[i].ts >= res.messages[i - 1].ts, 'порядок по времени не должен ломаться на ' + i);
  }
});

test('sanity: parseTimestamp на реальных timestamp из qwen-экспорта', () => {
  const json = JSON.parse(fs.readFileSync(REAL_FILE, 'utf8'));
  const list = json[0].chat.messages;
  assert.equal(MashaImport.parseTimestamp(list[0].timestamp), list[0].timestamp * 1000);
  assert.equal(MashaImport.parseTimestamp(list[list.length - 1].timestamp), list[list.length - 1].timestamp * 1000);
});

/* --------------------------------------------------------------- importFiles */

test('importFiles: читает через file.text(), по одному, без fetch, агрегирует статистику', async () => {
  const memory = fakeMemory();
  const f1 = fakeFile('one.json', JSON.stringify([{ role: 'user', content: 'привет', ts: 1700000000 }, { role: 'Маша', content: 'привет!', ts: 1700000060 }]));
  const f2 = fakeFile('two.json', JSON.stringify({ v: 1, messages: [['assistant', 1700000120000, 'третье']] }));

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('importFiles не должен использовать fetch'); };
  let progressCalls = 0;
  let lastDetail = null;
  try {
    const stats = await MashaImport.importFiles([f1, f2], {
      memory,
      onProgress: (done, total, detail) => { progressCalls++; lastDetail = detail; }
    });

    assert.equal(stats.files, 2);
    assert.equal(stats.inserted, 3);
    assert.equal(stats.errors.length, 0);
    assert.equal(memory.calls.length, 2, 'по одному вызову памяти на файл');
    assert.deepEqual(memory.calls.map((c) => c.messages.length), [2, 1]);
    assert.deepEqual(memory.calls.map((c) => c.messages[0].src), ['archive', 'archive']);
    assert.equal(f1._textCalls, 1, 'первый файл прочитан через text()');
    assert.equal(f2._textCalls, 1, 'второй файл прочитан через text()');
    assert.ok(progressCalls >= 4, 'прогресс должен дёргаться');
    assert.equal(lastDetail.phase === 'done' || !!lastDetail, true);
    assert.ok(stats.durationMs >= 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('importFiles: битый и пустой файл не роняют импорт, ошибки собираются', async () => {
  const memory = fakeMemory();
  const good = fakeFile('good.json', JSON.stringify([{ role: 'user', content: 'ок', ts: 1 }]));
  const broken = fakeFile('broken.json', '{ это не json');
  const empty = fakeFile('empty.json', '   ');

  const stats = await MashaImport.importFiles([broken, good, empty], { memory });
  assert.equal(stats.files, 1);
  assert.equal(stats.inserted, 1);
  assert.equal(stats.errors.length, 2);
  assert.ok(/broken\.json/.test(stats.errors[0]));
  assert.ok(/empty\.json/.test(stats.errors[1]));
  assert.equal(memory.calls.length, 1, 'память вызвана только для валидного файла');
});

test('importFiles: .json.gz распаковывается через DecompressionStream, нет API -> понятная ошибка', async () => {
  const text = JSON.stringify({ v: 1, messages: [['user', 1700000000000, 'из gzip'], ['assistant', 1700000060000, 'ок']] });
  const gzFile = fakeGzipFile('masha-archive.json.gz', text);
  const binFile = fakeGzipFile('archive.bin', text);

  const stats = await MashaImport.importFiles([gzFile, binFile], { memory: fakeMemory() });
  assert.equal(stats.files, 2);
  assert.equal(stats.inserted, 4);
  assert.equal(stats.errors.length, 0);

  const single = await MashaImport.importGzipBuffer(new Uint8Array(zlib.gzipSync(Buffer.from(text, 'utf8'))), { memory: fakeMemory() });
  assert.equal(single.inserted, 2);
  assert.equal(single.format, 'export');

  const realDS = globalThis.DecompressionStream;
  try {
    delete globalThis.DecompressionStream;
    await assert.rejects(
      () => MashaImport.importGzipBuffer(new Uint8Array(zlib.gzipSync(Buffer.from(text, 'utf8'))), { memory: fakeMemory() }),
      /DecompressionStream/
    );
    await assert.rejects(() => MashaImport.gunzipText(new Uint8Array([0x1f, 0x8b, 0x00])), /DecompressionStream/);
  } finally {
    globalThis.DecompressionStream = realDS;
  }
});

test('importFiles: без memory.importMessages бросает понятную ошибку', async () => {
  await assert.rejects(() => MashaImport.importFiles([fakeFile('a.json', '[]')], {}), /памяти/);
  await assert.rejects(() => MashaImport.importFiles([fakeFile('a.json', '[]')], { memory: {} }), /памяти/);
});

test('readFileText: строка, File с text(), File с arrayBuffer(), .gz', async () => {
  assert.equal(await MashaImport.readFileText('просто строка'), 'просто строка');
  assert.equal(await MashaImport.readFileText(fakeFile('a.json', '{"a":1}')), '{"a":1}');
  const noText = { name: 'b.json', arrayBuffer: async () => new TextEncoder().encode('{"b":2}').buffer };
  assert.equal(await MashaImport.readFileText(noText), '{"b":2}');
  assert.equal(await MashaImport.readFileText(fakeGzipFile('c.json.gz', '{"c":3}')), '{"c":3}');
  await assert.rejects(() => MashaImport.readFileText({ name: 'x.json' }), /читать/);
});

/* ------------------------------------------------------------ архив и индекс */

test('buildArchive: сортировка по ts, seq по порядку, бездатные в конец, компактный формат', () => {
  const messages = [
    { role: 'assistant', content: 'позже', ts: 1700000600000, src: 'b.json' },
    { role: 'user', content: 'без даты', ts: 0, src: 'a.json' },
    { role: 'user', content: 'раньше', ts: 1700000000000, src: 'a.json' },
    { role: 'system', content: 'мусор', ts: 1700000000000, src: 'a.json' }
  ];
  const archive = MashaImport.buildArchive(messages, { sources: ['a.json', 'b.json'] });
  assert.equal(archive.v, 1);
  assert.equal(archive.count, 3);
  assert.deepEqual(archive.sources, ['a.json', 'b.json']);
  assert.equal(typeof archive.builtAt, 'number');
  assert.deepEqual(archive.messages.map((r) => r[2]), ['раньше', 'позже', 'без даты']);
  assert.deepEqual(archive.messages.map((r) => r[0]), ['user', 'assistant', 'user']);
  assert.ok(Array.isArray(archive.messages[0]));
  assert.equal(archive.messages[0].length, 3);
  assert.equal(archive.messages[2][1], 0);
  // формат совместим с detectFormat/normalizeArchive (round-trip)
  assert.equal(MashaImport.detectFormat(archive), 'export');
  const back = MashaImport.normalizeArchive(archive, {});
  assert.equal(back.messages.length, 3);
});

test('buildIndex: постинги по seq, лимит maxPostings, round-trip с search-engine', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(['user', 1700000000000 + i * 1000, 'экзамен по математике номер ' + i]);
  rows.push(['assistant', 1700000100000, 'совсем другое сообщение']);

  const index = MashaImport.buildIndex(rows, { maxPostings: 1500 });
  assert.equal(index.v, 1);
  assert.equal(index.maxPostings, 1500);
  const lists = Object.values(index.terms);
  assert.ok(lists.length > 0);
  const full = lists.find((a) => a.length === 5);
  assert.ok(full, 'должен найтись терм, встречающийся в 5 сообщениях');
  assert.deepEqual(full, [1, 2, 3, 4, 5], 'постинги — это seq, по возрастанию');

  const limited = MashaImport.buildIndex(rows, { maxPostings: 3 });
  const trimmed = Object.values(limited.terms).find((a) => a.length === 3 && a[2] === 5);
  assert.ok(trimmed, 'лимит оставляет самые свежие seq');
  assert.deepEqual(trimmed, [3, 4, 5]);
});

test('buildIndex совпадает с терминами MashaSearch (если модуль есть)', () => {
  if (!MashaSearch || typeof MashaSearch.extractKeywords !== 'function') return;
  const rows = [['user', 1, 'экзамены сданы, экзамен позади']];
  const index = MashaImport.buildIndex(rows, {});
  const expected = MashaSearch.extractKeywords('экзамены сданы, экзамен позади', 12);
  for (const t of expected) {
    assert.ok(index.terms[t], 'терм из MashaSearch должен быть в индексе: ' + t);
  }
});

/* -------------------------------------------------- браузерный инструмент */

test('build-archive.html: работает при file://, без fetch и ES-модулей, кнопки на месте', () => {
  const htmlPath = fileURLToPath(new URL('../tools/build-archive.html', import.meta.url));
  assert.ok(fs.existsSync(htmlPath), 'нет tools/build-archive.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // модули проекта подключаются обычными тегами (ES-модули при file:// не работают)
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  assert.ok(srcs.includes('../js/import-manager.js'), 'нужен <script src="../js/import-manager.js">: ' + srcs.join(', '));
  assert.ok(srcs.includes('../js/search-engine.js'), 'нужен <script src="../js/search-engine.js">: ' + srcs.join(', '));

  // инлайновый скрипт должен быть синтаксически валидным
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n;\n');
  assert.ok(inline.trim().length > 500, 'инлайновый скрипт не найден');
  assert.doesNotThrow(() => new Function(inline), 'синтаксис инлайнового скрипта сломан');

  // file:// -> никаких сетевых запросов к локальным файлам
  assert.ok(!/\bfetch\s*\(/.test(inline), 'build-archive.html не должен использовать fetch');
  assert.ok(!/^\s*(import|export)\s/m.test(inline), 'нельзя использовать ES-модульный синтаксис');

  // элементы, к которым обращается скрипт, должны существовать в разметке
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...inline.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size >= 8, 'скрипт должен работать с элементами страницы');
  for (const id of used) assert.ok(ids.has(id), 'в HTML нет элемента #' + id);

  // интерфейс: input/drag&drop, кнопки, тёмная тема приложения
  assert.match(html, /<input[^>]+type="file"[^>]*multiple/i, 'нужен выбор нескольких файлов');
  assert.ok(/addEventListener\('drop'/.test(inline), 'нужен drag&drop');
  for (const needle of ['Собрать архив', 'Скачать masha-archive.json.gz', 'Скачать masha-index.json.gz',
    'masha-archive.json.gz', 'masha-index.json.gz', 'CompressionStream', '#0e1621', '#17212b', '#2b5278']) {
    assert.ok(html.includes(needle), 'в build-archive.html нет «' + needle + '»');
  }
});

test('браузерный путь сборки: CompressionStream(gzip) -> gunzipText (как в build-archive.html)', async () => {
  if (typeof CompressionStream !== 'function') return;
  const text = JSON.stringify({ v: 1, messages: [['user', 1700000000000, 'привет'], ['assistant', 1700000060000, 'привет!']] });
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x1f, 'должна получиться gzip-сигнатура');
  assert.equal(bytes[1], 0x8b);
  assert.equal(await MashaImport.gunzipText(bytes), text, 'скачанный .gz должен читаться обратно');
  const back = MashaImport.normalizeArchive(JSON.parse(await MashaImport.gunzipText(bytes)), {});
  assert.equal(back.messages.length, 2);
  assert.equal(back.format, 'export');
});

test('деградация без search-engine.js: индекс всё равно строится (важно для file://)', () => {
  const saved = globalThis.MashaSearch;
  try {
    delete globalThis.MashaSearch;
    MashaImport.setSearchEngine(null);
    const status = MashaImport.termEngine();
    assert.equal(status.ok, false, 'движка нет — статус должен быть false');
    assert.match(status.reason, /search-engine/);

    const index = MashaImport.buildIndex([['user', 1, 'экзамен по математике'], ['assistant', 2, 'математика сдана']], {});
    const lists = Object.values(index.terms);
    assert.ok(lists.length > 0, 'встроенный разбор должен дать термы');
    assert.ok(Object.values(index.terms).some((a) => a.includes(1)));
    assert.ok(MashaImport.fallbackKeywords('экзамены по математике', 12).length > 0);
    assert.equal(MashaImport.fallbackKeywords('', 12).length, 0);
  } finally {
    if (saved) {
      globalThis.MashaSearch = saved;
      MashaImport.setSearchEngine(saved);
    }
  }
});

/* ------------------------------------------------------------------- бэкапы */

test('exportBackup/importBackup: round-trip с памятью', async () => {
  const memory = {
    async getStats() { return { messages: 2, terms: 5, oldest: 1700000000000, newest: 1700000060000, sources: ['archive'], estBytes: 100 }; },
    async getRecent(limit) {
      assert.equal(limit, 500);
      return [
        { role: 'user', content: 'раз', ts: 1700000000000 },
        { role: 'assistant', content: 'два', ts: 1700000060000 }
      ];
    }
  };
  const blob = await MashaImport.exportBackup({ memory, settings: { model: 'x' }, facts: ['факт'], relations: { '1': 2 } });
  assert.ok(blob && typeof blob.text === 'function', 'должен вернуться Blob');
  const text = await blob.text();
  const parsed = JSON.parse(text);
  assert.equal(parsed.app, 'masha');
  assert.equal(parsed.kind, 'backup');
  assert.deepEqual(parsed.settings, { model: 'x' });
  assert.deepEqual(parsed.facts, ['факт']);
  assert.deepEqual(parsed.messages, [['user', 1700000000000, 'раз'], ['assistant', 1700000060000, 'два']]);
  assert.equal(parsed.archive.messages, 2);

  const back = await MashaImport.importBackup(fakeFile('masha-backup.json', text));
  assert.deepEqual(back.facts, ['факт']);
  assert.equal(back.messages.length, 2);

  await assert.rejects(() => MashaImport.importBackup(fakeFile('bad.json', '{oops')), /бэкап|разобрать/i);
  await assert.rejects(() => MashaImport.importBackup(fakeFile('bad2.json', '{"hello":1}')), /похоже/i);
});
