/* Адреса релея (API), которые приложение перебирает по порядку:
     первый рабочий и используется, остальные — запасные.
   Этот файл перезаписывается при сборке APK (см. .github/workflows/build-apk.yml):
   можно один раз задать переменную репозитория MASHA_ENDPOINTS
   (GitHub → Settings → Secrets and variables → Actions → Variables).

   Основной релей: masha-relay (Cloudflare Workers) — переписка, фото, музыка,
   распознавание речи (Workers AI). Сайт приложения: GitHub Pages. */
window.MASHA_DEFAULT_ENDPOINTS = [
  'https://masha-relay.lusnikoveduard9.workers.dev'
];
