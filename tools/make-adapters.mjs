#!/usr/bin/env node
/**
 * make-adapters.mjs — из одного файла worker/worker.js делает варианты релея,
 * чтобы версии не расходились:
 *
 *   worker/worker.js        — Cloudflare Workers (основной, вставляется в дашборд)
 *   worker/worker.mjs       — тот же код как ES-модуль (локальный запуск на компьютере)
 *   worker/deno-relay.js    — Deno Deploy (dash.deno.com, *.deno.dev)
 *   worker/netlify-relay.js — Netlify Function (netlify/functions/relay.js)
 *   api/relay.js            — Vercel serverless (/api/relay)
 *
 * Запуск: node tools/make-adapters.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'worker', 'worker.js');

const source = fs.readFileSync(SRC, 'utf8');
if (source.indexOf('export default {') === -1) {
  console.error('✖ В worker/worker.js не найден "export default {" — генерация отменена');
  process.exit(1);
}

const stamp = '/* СГЕНЕРИРОВАНО tools/make-adapters.mjs из worker/worker.js — правь worker.js и перезапусти генератор. */\n';

/* ES-модуль для Node (локальный релей) */
fs.writeFileSync(path.join(ROOT, 'worker', 'worker.mjs'), source, 'utf8');

/* Deno Deploy: Deno — это ES-модули, добавляем только точку входа */
const deno = stamp + source
  .replace('export default {', 'const __relay = {')
  .replace(/^export \{[^}]*\};?\s*$/m, '') + `

/* ------------------------------------------------------------------
   Точка входа Deno Deploy.
     1) dash.deno.com → войти через GitHub → New Playground
     2) вставить этот файл целиком → Save & Deploy
     3) Settings → Environment Variables → DEEPSEEK_API_KEY = ключ
     4) адрес https://имя.логин.deno.dev должен вернуть {"ok":true,...,"hasKey":true}
   ------------------------------------------------------------------ */
const __DENO_ENV_KEYS = [
  'DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'DEEPSEEK_TEXT_MODEL', 'DEEPSEEK_VISION_MODEL',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_THOUGHTS', 'RELAY_TIMEOUT_MS', 'RELAY_MAX_TOKENS'
];

function __denoEnv() {
  const env = {};
  for (const key of __DENO_ENV_KEYS) {
    const value = Deno.env.get(key);
    if (value !== undefined && value !== null && value !== '') env[key] = value;
  }
  return env;
}

Deno.serve((request) => __relay.fetch(request, __denoEnv(), {}));
`;
fs.writeFileSync(path.join(ROOT, 'worker', 'deno-relay.js'), deno, 'utf8');

/* CommonJS-версия для Netlify */
const cjs = stamp + source
  .replace('export default {', 'const __relay = {')
  .replace(/^export \{[^}]*\};?\s*$/m, '') + `

/* ------------------------------------------------------------------
   Netlify Function. Файл должен лежать как netlify/functions/relay.js
     1) app.netlify.com → Add new site → Import an existing project (или Drop)
     2) задеплоить, затем Site configuration → Environment variables →
        DEEPSEEK_API_KEY = ключ
     3) адрес: https://ИМЯ.netlify.app/.netlify/functions/relay
   ------------------------------------------------------------------ */
exports.handler = async function (event) {
  const host = (event.headers && (event.headers.host || event.headers.Host)) || 'localhost';
  const url = event.rawUrl || ('https://' + host + (event.path || '/'));
  const method = event.httpMethod || 'GET';

  const headers = {};
  const incoming = event.headers || {};
  Object.keys(incoming).forEach(function (k) { headers[k] = incoming[k]; });

  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : (event.body || '');
  }

  const request = new Request(url, { method: method, headers: headers, body: body });
  const response = await __relay.fetch(request, process.env, {});

  const outHeaders = {};
  response.headers.forEach(function (value, key) { outHeaders[key] = value; });

  return { statusCode: response.status, headers: outHeaders, body: await response.text() };
};
`;
fs.writeFileSync(path.join(ROOT, 'worker', 'netlify-relay.js'), cjs, 'utf8');

/* Vercel: тот же код, но обработчик вида (req, res) */
const vercel = stamp + source
  .replace('export default {', 'const __relay = {')
  .replace(/^export \{[^}]*\};?\s*$/m, '') + `

/* ------------------------------------------------------------------
   Vercel serverless. Файл лежит как api/relay.js → адрес /api/relay
     1) Vercel → Settings → Environment Variables → DEEPSEEK_API_KEY = ключ
     2) Redeploy
     3) https://проект.vercel.app/api/relay должен вернуть {"ok":true,...,"hasKey":true}
   ------------------------------------------------------------------ */
export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  };

  if (method === 'OPTIONS') {
    Object.keys(headers).forEach(function (k) { res.setHeader(k, headers[k]); });
    return res.status(204).end();
  }

  const host = (req.headers && (req.headers.host || req.headers.Host)) || 'relay.local';
  const url = 'https://' + host + (req.url || '/');

  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    if (typeof req.body === 'string') body = req.body;
    else if (req.body && typeof req.body === 'object') body = JSON.stringify(req.body);
    else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks).toString('utf8');
    }
  }

  try {
    const request = new Request(url, { method: method, headers: req.headers || {}, body: body });
    const response = await __relay.fetch(request, process.env, {});
    res.status(response.status);
    response.headers.forEach(function (value, key) { res.setHeader(key, value); });
    res.send(await response.text());
  } catch (e) {
    Object.keys(headers).forEach(function (k) { res.setHeader(k, headers[k]); });
    res.status(500).send(JSON.stringify({
      ok: false,
      error: 'server_error',
      message: 'внутренняя ошибка релея',
      reply: 'блин, у меня чето связь пропала, давай еще раз?'
    }));
  }
}
`;
fs.writeFileSync(path.join(ROOT, 'api', 'relay.js'), vercel, 'utf8');

console.log('✓ worker/worker.mjs         — локальный запуск (Node)');
console.log('✓ worker/deno-relay.js      — Deno Deploy');
console.log('✓ worker/netlify-relay.js   — Netlify Function');
console.log('✓ api/relay.js              — Vercel');
