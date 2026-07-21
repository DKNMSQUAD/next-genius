// Next Genius SMTP drain.
//
// Why this exists: Apps Script's own email service is capped near 100/day and no
// amount of tuning moves it. The SAME Workspace mailbox will send ~2000/day over
// SMTP, because that is a separate budget. So the queue stays where it is, in the
// sheet, and this just becomes a second, much wider lane draining it.
//
// Safety: rows are CLAIMED by the pull endpoint before anything is sent, and only
// marked sent once the SMTP server has accepted them. A crash strands a row as
// 'sending' (visible, requeued by hand) and can never duplicate one. Colleges that
// have already signed up are filtered server-side, on this lane too.
//
//   node drain.js --test you@x.com     one message to prove the credential
//   node drain.js --dry                counts only, sends nothing
//   node drain.js [--max 1800]         drain until empty or the cap is reached

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');

// This repo is public. Nothing secret is allowed to live in this file: the token
// and the mailbox password come from the environment, or on DK's own machine from
// a 0600 file that is not in the repo.
const EXEC = process.env.NG_EXEC_URL
  || 'https://script.google.com/macros/s/AKfycbwVxIhz6N-vUNVhpTJOw2rFOfO8ZZOcsbL9JOj7-Ha2eWY7YEFlB6R-Ptg9PNC7NmT-xQ/exec';
const TOKEN = process.env.NG_OPS_TOKEN;
const CRED = path.join(os.homedir(), '.ng-helpdesk-app-password.txt');

if (!TOKEN) {
  console.error('NG_OPS_TOKEN is not set. Export it, or add it as a repo secret.');
  process.exit(1);
}

// Gmail's published ceiling for a Workspace mailbox is 2000 recipients/day. Stop
// short of it: hitting the wall gets the account rate-limited, not just refused.
const DAILY_CAP = 1800;
// Rows are claimed at pull time, so the batch size IS the blast radius if this
// process dies mid-batch. Keep it small: a stranded row needs a manual recover.
const BATCH = 10;
const GAP_MS = 700;      // ~5100/hr, gentle enough that Google does not throttle

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? (process.argv[i + 1] || true) : d; };
const DRY = process.argv.includes('--dry');
const TEST = arg('--test', null);
const MAX = parseInt(arg('--max', DAILY_CAP), 10) || DAILY_CAP;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function credentials() {
  // On a runner the mailbox comes from secrets; on DK's Mac from the 0600 file
  // an earlier session already wrote, so neither path needs him to do anything.
  if (process.env.NG_SMTP_USER && process.env.NG_SMTP_PASS) {
    return { user: process.env.NG_SMTP_USER, pass: process.env.NG_SMTP_PASS.replace(/\s+/g, '') };
  }
  if (!fs.existsSync(CRED)) {
    console.error('No credential: set NG_SMTP_USER/NG_SMTP_PASS, or provide ' + CRED);
    process.exit(1);
  }
  const txt = fs.readFileSync(CRED, 'utf8');
  const user = (txt.match(/username:\s*(\S+)/) || [])[1];
  const pass = (txt.match(/password:\s*(\S+)/) || [])[1];
  if (!user || !pass) { console.error('Could not parse ' + CRED); process.exit(1); }
  return { user, pass: pass.replace(/\s+/g, '') };
}

// Apps Script intermittently answers with an HTML error page instead of JSON,
// usually when a scheduled tick is touching the same sheet. That is a blip, not a
// failure: retry it. Letting it kill the run once left rows claimed but unsent.
async function api(query, tries = 4) {
  let last = '';
  for (let n = 0; n < tries; n++) {
    try {
      const r = await fetch(EXEC + '?' + query + '&token=' + encodeURIComponent(TOKEN), { redirect: 'follow' });
      const t = await r.text();
      try { return JSON.parse(t); } catch (err) { last = t.slice(0, 120); }
    } catch (err) { last = String(err.message || err).slice(0, 120); }
    await sleep(2000 * (n + 1));
  }
  throw new Error('api failed after ' + tries + ' tries: ' + last);
}

(async () => {
  const { user, pass } = credentials();
  const tx = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    pool: true, maxConnections: 3, maxMessages: 100,
  });

  await tx.verify();
  console.log('SMTP ready as ' + user);

  // The mail must keep coming FROM the address the colleges and students already
  // know. apply@ is a verified send-as alias on this mailbox, so Gmail signs it
  // for next-genius.com and alignment holds.
  const FROM = '"Next Genius" <apply@next-genius.com>';

  if (TEST) {
    const info = await tx.sendMail({
      from: FROM, to: TEST, replyTo: 'apply@next-genius.com',
      subject: 'Next Genius SMTP lane test',
      text: 'If you are reading this, the SMTP lane works and the daily ceiling is now the mailbox limit, not the Apps Script one.',
    });
    console.log('test sent:', info.messageId);
    tx.close();
    return;
  }

  if (DRY) {
    const h = await api('ops_health=1');
    console.log('queued right now:', h.health.queued);
    tx.close();
    return;
  }

  let sent = 0, failed = 0, suppressed = 0, bad = 0;
  const started = Date.now();

  while (sent < MAX) {
    const pull = await api('queue_pull=1&limit=' + Math.min(BATCH, MAX - sent));
    if (!pull.ok) throw new Error('pull failed: ' + JSON.stringify(pull).slice(0, 200));
    suppressed += pull.suppressed || 0;
    bad += pull.bad || 0;
    if (!pull.rows.length) { console.log('queue empty'); break; }

    const ok = [], back = [];
    for (const row of pull.rows) {
      try {
        await tx.sendMail({
          from: FROM, to: row.to, replyTo: 'apply@next-genius.com',
          subject: row.subject,
          text: row.body || undefined,
          html: row.html || undefined,
        });
        ok.push(row.row); sent++;
      } catch (err) {
        const msg = String(err && err.message || err);
        // A refused recipient is that row's problem. Anything that smells like the
        // account being throttled must stop the run, not burn through the backlog.
        if (/limit|rate|quota|too many/i.test(msg)) {
          back.push(row.row);
          console.error('THROTTLED, stopping: ' + msg.slice(0, 120));
          await api('queue_confirm=1&status=queued&rows=' + back.concat(pull.rows.slice(pull.rows.indexOf(row) + 1).map(r => r.row)).join(','));
          if (ok.length) await api('queue_confirm=1&status=sent&rows=' + ok.join(','));
          console.log(`sent ${sent}, failed ${failed}, suppressed ${suppressed}, bad ${bad}`);
          tx.close();
          return;
        }
        back.push(row.row); failed++;
        console.error('failed ' + row.to + ': ' + msg.slice(0, 100));
      }
      await sleep(GAP_MS);
    }
    if (ok.length) await api('queue_confirm=1&status=sent&rows=' + ok.join(','));
    if (back.length) await api('queue_confirm=1&status=queued&rows=' + back.join(','));
    console.log(`  ${sent} sent (${Math.round((Date.now() - started) / 1000)}s), ${pull.stillQueued} left`);
  }

  console.log(`done. sent ${sent}, failed ${failed}, suppressed ${suppressed}, bad ${bad}`);
  tx.close();
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
