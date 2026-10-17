/* Service Worker «Маши»: приложение работает офлайн, но код обновляется.
   1) документ (index.html) — network-first, при отсутствии сети из кэша;
   2) js/sw-модули — тоже network-first, чтобы HTML и модули были одной версии;
   3) картинки — cache-first;
   4) запросы к API — никогда не кэшируются;
   5) уведомления от Маши показываются через этот воркер — так они приходят
      и на телефоне, даже когда приложение свёрнуто или закрыто. */

const CACHE = 'masha-v5';
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './js/search-engine.js',
  './js/memory-db.js',
  './js/memory-brain.js',
  './js/import-manager.js',
  './js/api-client.js',
  './js/initiative.js',
  './js/config.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(CORE.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) { /* необязательный файл */ }
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

/* Нажатие на уведомление — открыть приложение и показать его окно. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try { await client.focus(); return; } catch (e) { /* ignore */ }
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/* Если приложение пришлёт push (на будущее) — тоже показываем уведомление. */
self.addEventListener('push', event => {
  let payload = { title: 'Маша', body: '' };
  try { payload = Object.assign(payload, event.data ? event.data.json() : {}); } catch (e) { /* ignore */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'Маша', {
    body: payload.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [90, 40, 90],
    tag: 'masha-push',
    data: { url: payload.url || './' }
  }));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                    // POST к релею — напрямую
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;     // чужой хост (воркер и т.п.)
  if (url.pathname.indexOf('/api/') === 0) return;     // API не кэшируем

  const isDocument = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  const isCode = /\.(?:js|css|json)$/i.test(url.pathname);
  const isImage = /\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname);

  if (isDocument || isCode) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(isDocument ? './index.html' : req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = (await cache.match(req)) || (isDocument ? await cache.match('./index.html') : null);
        return cached || new Response(
          '<!doctype html><meta charset="utf-8"><body style="background:#0e1621;color:#fff;font-family:sans-serif;padding:24px">Нет интернета. Открой приложение, когда появится связь.</body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
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

  event.respondWith((async () => {
    try { return await fetch(req); }
    catch (e) { return (await caches.match(req)) || Response.error(); }
  })());
});
