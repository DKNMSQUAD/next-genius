// Sending watchdog for Next Genius.
//
// All judgement lives in the Apps Script (next to the data): one ops_tick call
// self-heals error-marked rows, drains the Gmail + Brevo lanes as quota frees,
// fires partner wave 2 once wave 1 is fully out, and alerts DK on a real stall.
// This Worker exists only to call that tick on a schedule, because Apps Script
// time triggers need interactive consent we do not have.
const EXEC = 'https://script.google.com/macros/s/AKfycbwVxIhz6N-vUNVhpTJOw2rFOfO8ZZOcsbL9JOj7-Ha2eWY7YEFlB6R-Ptg9PNC7NmT-xQ/exec';

async function call(env, query) {
  const url = EXEC + '?' + query + '&token=' + encodeURIComponent(env.MAINT_TOKEN);
  const r = await fetch(url, { redirect: 'follow' });
  return await r.text();
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(call(env, 'ops_tick=1'));
  },
  // ?run=1&token=  forces a tick now; ?health=1&token=  reports state. Both need the maint token.
  async fetch(request, env) {
    const u = new URL(request.url);
    const authed = u.searchParams.get('token') === env.MAINT_TOKEN;
    if (u.searchParams.get('run') === '1' && authed) {
      return new Response(await call(env, 'ops_tick=1'), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.searchParams.get('health') === '1' && authed) {
      return new Response(await call(env, 'ops_health=1'), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('ng-mail-drain watchdog alive');
  },
};
