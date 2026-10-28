/* Адреса релея (API), которые приложение перебирает по порядку:
     первый рабочий и используется, остальные — запасные.
   Этот файл перезаписывается при сборке APK (см. .github/workflows/build-apk.yml):
   можно один раз задать переменную репозитория MASHA_ENDPOINTS
   (GitHub → Settings → Secrets and variables → Actions → Variables).

   masha-relay — рабочий релей в Cloudflare (переписка, фото, музыка, распознавание речи).
   Остальные — запасные адреса на случай сбоя основного. */
window.MASHA_DEFAULT_ENDPOINTS = [
  'https://masha-relay.lusnikoveduard9.workers.dev',
  'https://masha.lusnikoveduard9.workers.dev',
  'https://masha-mf6o.vercel.app/api/relay',
  'https://masha-mf60.vercel.app/api/relay'
];
