#!/usr/bin/env node
/**
 * transcribe-voice.mjs — автоматически подписать её голосовые.
 *
 * Что делает: берёт все её ГС из voice/raw/, отправляет их на твой релей
 * (распознавание речи — Workers AI / Groq / и т.д.) и записывает
 * voice/clips.json: «что сказано» → файл. После этого она будет отвечать
 * её НАСТОЯЩИМ голосом на все фразы, которые распознались.
 *
 * Запуск (на своём ПК, из папки проекта):
 *     node tools/transcribe-voice.mjs https://masha.lusnikoveduard9.workers.dev
 *
 * Можно ограничить количество:  node tools/transcribe-voice.mjs <url> 50
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RAW = path.join(ROOT, 'voice', 'raw');
const OUT = path.join(ROOT, 'voice', 'clips.json');

const endpoint = (process.argv[2] || '').replace(/\/+$/, '');
const limit = parseInt(process.argv[3] || '100000', 10);
if (!endpoint) {
  console.error('Укажи адрес релея: node tools/transcribe-voice.mjs https://твой.workers.dev');
  process.exit(2);
}

function b64(file) {
  return fs.readFileSync(file).toString('base64');
}

async function stt(textB64, mime) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stt: true, audio: textB64, mime: mime })
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[^а-яё0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const files = fs.readdirSync(RAW)
  .filter(f => /\.(ogg|mp3|wav|m4a|flac|opus)$/i.test(f))
  .slice(0, limit);

console.log('голосовых: ' + files.length + ' → релей: ' + endpoint);

// проверяем, что распознавание включено
const probe = await stt(Buffer.alloc(0).toString('base64'), 'audio/ogg').catch(() => null);
if (probe && probe.error === 'no_stt_key') {
  console.error('\nРаспознавание на релее не настроено.');
  console.error('Cloudflare → воркер → Settings → Bindings → Add → Workers AI → имя AI → Deploy.');
  console.error(probe.message || '');
  process.exit(3);
}

const clips = [];
let ok = 0, fail = 0;
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const full = path.join(RAW, f);
  const sizeMb = fs.statSync(full).size / 1048576;
  if (sizeMb > 12) { fail++; continue; }               // слишком большой файл
  const mime = /\.ogg$/i.test(f) ? 'audio/ogg' : /\.mp3$/i.test(f) ? 'audio/mpeg'
    : /\.wav$/i.test(f) ? 'audio/wav' : /\.m4a$/i.test(f) ? 'audio/mp4' : 'audio/ogg';
  process.stdout.write('[' + (i + 1) + '/' + files.length + '] ' + f + ' … ');
  try {
    const r = await stt(b64(full), mime);
    if (r && r.ok && r.text) {
      const text = String(r.text).replace(/\s+/g, ' ').trim();
      if (text.length >= 2) {
        clips.push({ text, file: 'voice/raw/' + f, lang: 'ru', auto: true });
        ok++;
        console.log('«' + text.slice(0, 60) + '»');
      } else { fail++; console.log('пусто'); }
    } else { fail++; console.log(r && r.message ? r.message.slice(0, 60) : 'нет текста'); }
  } catch (e) {
    fail++;
    console.log('ошибка: ' + (e && e.message));
  }
}

// дедуп по нормализованному тексту — оставляем первую (обычно самую короткую)
const seen = new Set();
const unique = [];
for (const c of clips) {
  const k = norm(c.text);
  if (!k || seen.has(k)) continue;
  seen.add(k);
  unique.push(c);
}

fs.writeFileSync(OUT, JSON.stringify({
  _note: 'Сгенерировано transcribe-voice.mjs: реальные фразы её голосом. Можно править вручную.',
  clips: unique
}, null, 1), 'utf8');

console.log('\nготово: распознано ' + ok + ', не вышло ' + fail);
console.log('в clips.json записано ' + unique.length + ' фраз → ' + OUT);
console.log('Теперь загрузи voice/clips.json и файлы voice/raw/ в GitHub.');
