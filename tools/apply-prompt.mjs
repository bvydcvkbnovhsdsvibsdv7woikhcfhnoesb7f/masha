#!/usr/bin/env node
/**
 * apply-prompt.mjs — вставить новый промпт в index.html и PROMPT.md.
 *
 *   node tools/apply-prompt.mjs                  # взять tools/prompt-new.txt
 *   node tools/apply-prompt.mjs --check          # только проверить, совпадает ли
 *
 * Меняет ровно содержимое `const DEFAULT_PROMPT = \`...\`;` в index.html
 * и блок промпта в PROMPT.md — больше ничего не трогает.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROMPT_FILE = path.join(HERE, 'prompt-new.txt');
const INDEX = path.join(ROOT, 'index.html');
const PROMPT_MD = path.join(ROOT, 'PROMPT.md');

const check = process.argv.includes('--check');
const prompt = fs.readFileSync(PROMPT_FILE, 'utf8').replace(/\r\n/g, '\n').trimEnd();

// в шаблонную строку нельзя вставлять ` и ${
if (/[`]/.test(prompt)) throw new Error('в промпте есть обратный апостроф — замените его');
if (prompt.includes('${')) throw new Error('в промпте есть ${ — уберите, иначе JS-шаблон сломается');

const html = fs.readFileSync(INDEX, 'utf8');
const start = html.indexOf('const DEFAULT_PROMPT = `');
if (start === -1) throw new Error('в index.html не найден DEFAULT_PROMPT');
const bodyStart = start + 'const DEFAULT_PROMPT = `'.length;
const end = html.indexOf('`;', bodyStart);
if (end === -1) throw new Error('не найден конец DEFAULT_PROMPT');
const oldPrompt = html.slice(bodyStart, end);

const header = 'const DEFAULT_PROMPT = `';
const nextHtml = html.slice(0, start) + header + prompt + html.slice(end);

if (check) {
  const same = oldPrompt.trim() === prompt.trim();
  console.log(same ? '✓ промпт в index.html совпадает с tools/prompt-new.txt'
                   : '✖ промпт в index.html ОТЛИЧАЕТСЯ от tools/prompt-new.txt');
  process.exitCode = same ? 0 : 1;
} else {
  fs.writeFileSync(INDEX, nextHtml, 'utf8');
  console.log('✓ index.html: промпт обновлён (' + oldPrompt.length + ' → ' + prompt.length + ' символов)');
}

// PROMPT.md — тот же текст в блоке ```text ... ```
const md = fs.readFileSync(PROMPT_MD, 'utf8');
const mdStart = md.indexOf('```text');
if (mdStart !== -1) {
  const mdBodyStart = md.indexOf('\n', mdStart) + 1;
  const mdEnd = md.indexOf('```', mdBodyStart);
  if (mdEnd !== -1 && !check) {
    fs.writeFileSync(PROMPT_MD, md.slice(0, mdBodyStart) + '\n' + prompt + '\n' + md.slice(mdEnd), 'utf8');
    console.log('✓ PROMPT.md: текст промпта обновлён');
  } else if (!check) {
    console.log('• PROMPT.md: блок ```text не найден, оставил как есть');
  }
}

const stats = {
  строк: prompt.split('\n').length,
  символов: prompt.length,
  слов: prompt.split(/\s+/).filter(Boolean).length,
  'оценка токенов': Math.ceil(prompt.length / 3.5)
};
console.log('промпт:', JSON.stringify(stats, null, 0));
