/* Service Worker «Маши».
   Задачи:
   1) приложение целиком работает из кэша (не зависит от сайта);
   2) но свежий index.html/js подтягиваются из сети, если она есть —
      иначе можно годами сидеть на старой версии;
   3) запросы к API никогда не кэшируются и не подменяются страницей. */

const CACHE = 'masha-v3';
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './js/search-engine.js',
  './js/memory-db.js',
  './js/import-manager.js',
  './js/api-client.js',
  './js/initiative.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Кэшируем по одному: отсутствие необязательного файла не должно ломать установку.
    await Promise.all(CORE.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) { /* ignore */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isApi(url) {
  return url.pathname.indexOf('/api/') === 0 || url.pathname === '/api/relay';
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;            // POST к релею — всегда напрямую

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;  // чужой хост (Cloudflare Worker и т.п.)
  if (isApi(url)) return;                           // API не кэшируем вообще

  const isDocument = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  const isCode = /\.(?:js|css|json)$/i.test(url.pathname);
  const isImage = /\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname);

  if (isDocument) {
    // network-first: свежий HTML, при отсутствии сети — кэш
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match('./index.html') || await caches.match('./');
        return cached || new Response(
          '<!doctype html><meta charset="utf-8"><body style="background:#0e1621;color:#fff;font-family:sans-serif;padding:24px">Нет интернета. Открой приложение ещё раз, когда появится связь.</body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  if (isCode) {
    // network-first для кода: HTML и js всегда одной версии (иначе после
    // обновления может получиться «новый index.html + старые модули»).
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  if (isImage) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  // всё остальное — сеть, при ошибке кэш
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (e) {
      const cached = await caches.match(req);
      return cached || Response.error();
    }
  })());
});
