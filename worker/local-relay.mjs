#!/usr/bin/env node
/**
 * local-relay.mjs — релей «Маши» прямо на твоём компьютере, без хостинга.
 *
 * Проверить Машу целиком, не разбираясь с Cloudflare:
 *   PowerShell:  $env:DEEPSEEK_API_KEY="sk-твой-ключ"; node worker/local-relay.mjs
 *   cmd:         set DEEPSEEK_API_KEY=sk-твой-ключ && node worker/local-relay.mjs
 *
 * Затем в приложении: Настройки → 🛰️ Серверы Маши → добавить строку
 *   http://127.0.0.1:8787
 * → «Сохранить серверы» → «Проверить» (должна быть зелёная галочка).
 *
 * Работает и с сайтом на GitHub Pages: браузер разрешает обращаться
 * к http://127.0.0.1 даже со страницы, открытой по https.
 *
 * Релей слушает только этот компьютер (127.0.0.1) — ключ наружу не уходит.
 * Остановить: Ctrl+C.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import relay from './worker.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

export default relay;

export function startLocalRelay(port = PORT, host = HOST) {
  if (!process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_KEY) {
    console.error('');
    console.error('✖ Не задан ключ DeepSeek. Запусти так:');
    console.error('   PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."; node worker/local-relay.mjs');
    console.error('   cmd:         set DEEPSEEK_API_KEY=sk-... && node worker/local-relay.mjs');
    console.error('');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);

      const url = 'http://' + (req.headers.host || host + ':' + port) + (req.url || '/');
      const bodyless = req.method === 'GET' || req.method === 'HEAD';
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: bodyless ? undefined : raw
      });

      const response = await relay.fetch(request, process.env, {});

      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        error: 'local_error',
        message: String((err && err.message) || err),
        reply: 'блин, у меня чето связь пропала, давай еще раз?'
      }));
    }
  });

  server.listen(port, host, () => {
    console.log('');
    console.log('  ✅ Локальный релей «Маши» запущен');
    console.log('  Адрес для приложения:  http://' + host + ':' + port);
    console.log('  Проверка в браузере:   http://' + host + ':' + port + '/  (ждём JSON с "hasKey":true)');
    console.log('  Остановить:            Ctrl+C');
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\nОстанавливаю релей.');
    server.close(() => process.exit(0));
  });

  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startLocalRelay();
