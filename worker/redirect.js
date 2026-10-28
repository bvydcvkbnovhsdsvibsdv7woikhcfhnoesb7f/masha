/* Воркер-редирект: старый адрес (masha.lusnikoveduard9.workers.dev) теперь
   перенаправляет на новый сайт приложения в GitHub Pages. */
const NEW_HOME = 'https://bvydcvkbnovhsdsvibsdv7woikhcfhnoesb7f.github.io/masha/';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // API-запросы сюда попадать не должны — подскажем, куда идти
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(JSON.stringify({
        ok: false,
        error: 'wrong_endpoint',
        message: 'API переехал: используй https://masha-relay.lusnikoveduard9.workers.dev'
      }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/^\//, '');
    return Response.redirect(NEW_HOME + path + url.search, 302);
  }
};
