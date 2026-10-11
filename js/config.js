/* Адреса релея (API), которые перебирает приложение.
   Этот файл перезаписывается при сборке APK (см. .github/workflows/build-apk.yml),
   поэтому менять его вручную не обязательно: можно один раз задать
   переменную репозитория MASHA_ENDPOINTS в GitHub → Settings → Variables.

   Примеры:
     ["https://masha-mf6o.vercel.app/api/relay"]
     ["https://masha-mf6o.vercel.app/api/relay", "https://masha-relay.ВАШ-ЛОГИН.workers.dev"]
*/
window.MASHA_DEFAULT_ENDPOINTS = [
  'https://masha-mf6o.vercel.app/api/relay'
];
