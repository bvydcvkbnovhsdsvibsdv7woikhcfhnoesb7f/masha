#!/usr/bin/env node
/**
 * test-prompt.mjs — живая проверка: что она отвечает на тестовые вопросы.
 *
 *   $env:DEEPSEEK_API_KEY="sk-..."; node tools/test-prompt.mjs
 *
 * Собирает РОВНО тот промпт, что уходит из приложения (промпт + профиль + темы +
 * база знаний), задаёт несколько вопросов через DeepSeek и печатает ответы.
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
const MashaImport = require(path.join(ROOT, 'js', 'import-manager.js'));

const KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '';
if (!KEY) { console.error('нужен DEEPSEEK_API_KEY'); process.exit(2); }

const brain = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-brain.json.gz'))).toString('utf8'));
const kb = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'archive', 'masha-kb.json.gz'))).toString('utf8'));
MashaBrain.setBrain(brain);
MashaBrain.setKb(kb);

const promptFile = path.join(ROOT, 'tools', 'prompt-new.txt');
let BASE = fs.readFileSync(promptFile, 'utf8');

const QUESTIONS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'как тебя зовут?',
  'а разве ты не Вика?',
  'как мы познакомились?',
  'приезжай ко мне',
  'что делаешь?',
  'я тебя люблю'
];

function systemFor(text) {
  const block = MashaBrain.assemble(text, [], { maxChars: 9000 });
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let sys = BASE
    .replace('{{TIME}}', now)
    .replace('{{STATE}}', 'calm')
    .replace('{{FACTS}}', 'нет фактов')
    .replace('{{CALENDAR}}', 'Его ДР: 1 октября; Годовщина: 18 августа; Её ДР: 23 мая')
    .replace('{{PLAYLIST}}', 'плейлист пуст')
    .replace('{{RELATIONSHIP_VALUE}}', '93')
    .replace('{{RELATIONSHIP_TONE}}', 'нежная, но коротко')
    .replace('{{TRENDS}}', 'тренды не загружены')
    .replace('{{WEATHER}}', 'неизвестно');
  sys += '\n\n═══ ТВОИ ВОСПОМИНАНИЯ (реальная переписка) ═══\n' + block;
  sys += '\n\nВАЖНО: выше реальные воспоминания. Не выдумывай имён и событий, которых там нет.';
  return sys;
}

async function ask(text) {
  const body = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: systemFor(text) },
      { role: 'user', content: text }
    ],
    max_tokens: 70,
    temperature: 0.9,
    stream: false
  };
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) return 'ОШИБКА: ' + JSON.stringify(data).slice(0, 200);
  return (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
}

console.log('Живая проверка промпта — вопросов: ' + QUESTIONS.length + '\n');
for (const q of QUESTIONS) {
  const sys = systemFor(q);
  const a = await ask(q);
  console.log('── он: ' + q);
  console.log('   она: ' + a.replace(/\n/g, ' / '));
  console.log('   (в промпт ушло ' + sys.length + ' символов)\n');
}
