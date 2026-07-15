// Drains the Next Genius Apps Script mailqueue on a schedule. Gmail's daily
// send budget resets on a rolling window, so we poke the drain endpoint a few
// times a day and let the Apps Script side enforce the quota. Nothing sends
// twice: the queue marks each row sent/errored.
const EXEC = 'https://script.google.com/macros/s/AKfycbwVxIhz6N-vUNVhpTJOw2rFOfO8ZZOcsbL9JOj7-Ha2eWY7YEFlB6R-Ptg9PNC7NmT-xQ/exec';

async function drain(env) {
  const url = EXEC + '?drain_queue=1&token=' + encodeURIComponent(env.MAINT_TOKEN);
  const r = await fetch(url, { redirect: 'follow' });
  return await r.text();
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drain(env));
  },
  // manual poke + health check
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.searchParams.get('run') === '1' && u.searchParams.get('token') === env.MAINT_TOKEN) {
      return new Response(await drain(env), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('ng-mail-drain alive');
  },
};
