// Drains the Next Genius Apps Script mailqueue on a schedule. Gmail's daily
// send budget resets on a rolling window, so we poke the drain endpoint a few
// times a day and let the Apps Script side enforce the quota. Nothing sends
// twice: the queue marks each row sent/errored.
const EXEC = 'https://script.google.com/macros/s/AKfycbwVxIhz6N-vUNVhpTJOw2rFOfO8ZZOcsbL9JOj7-Ha2eWY7YEFlB6R-Ptg9PNC7NmT-xQ/exec';

// Wave 2 (personalised reminder) may not start before this date, and only
// once the wave-1 queue has fully drained. partner_blast is idempotent per
// lead, so calling it on every quiet day is safe: it stamps/queues only
// leads that still lack the wave and skips everyone who answered.
const WAVE2_EARLIEST = '2026-08-01';

async function getJson(url) {
  const r = await fetch(url, { redirect: 'follow' });
  try { return await r.json(); } catch (e) { return null; }
}

async function drain(env) {
  const t = encodeURIComponent(env.MAINT_TOKEN);
  const out = { drain: await getJson(EXEC + '?drain_queue=1&token=' + t) };
  const today = new Date().toISOString().slice(0, 10);
  if (today >= WAVE2_EARLIEST) {
    const q = await getJson(EXEC + '?queue_status=1&token=' + t);
    if (q && q.ok && q.queued === 0) {
      out.wave2 = await getJson(EXEC + '?partner_blast=1&wave=2&token=' + t);
    }
  }
  return JSON.stringify(out);
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
