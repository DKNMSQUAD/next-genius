# Next Genius — Migration to Official Account (from 2026-06-20)

> **READ THIS FIRST in any Next Genius session on/after 2026-06-20.** Until then, DO NOT touch the apex DNS or move any accounts. Everything below is on hold until the official email is in hand.

## The plan (DK, decided 2026-06-12)
On **2026-06-20** the team gets the **official Next Genius email account**. Once it's in hand:
1. Move **everything** related to Next Genius onto that official account: hosting (Cloudflare Pages), Firebase/Firestore project (`next-genius-auto`), the domain, the Apps Scripts, the Google Sheet — all of it.
2. **Remove the domain from Wix entirely** (DNS currently lives at Wix; this is what blocks the apex SSL fix today).
3. From **2026-06-20 onward, all emails send from the official account only** (not `dknmsquad@gmail.com`).

## Why we're waiting (do not "fix" these before the 20th)
- **Apex SSL (`next-genius.com` no-www) is intentionally left broken until then.** It can't get a cert because DNS is at Wix and CF wants a CNAME/alias it can't place. The proper fix happens as part of moving DNS off Wix onto the official/Cloudflare account on the 20th. `www.next-genius.com` works perfectly and is canonical, so no urgency. (CF Pages custom domain `next-genius.com` is currently sitting `pending`; that's fine — it'll resolve once DNS moves.)
- Don't re-point apex A-records or add the domain to a CF zone before the migration — it would just be redone on the 20th.

## What sends email today (to be repointed on the 20th)
All email currently flows through the **sheet-sync Apps Script**, executing as **dknmsquad@gmail.com**, with `replyTo: nextgeniusindia@gmail.com`.
- After migration: re-create / re-own the Apps Script under the official account (or keep it but change the executing account), and update `replyTo` + sender to the official address.
- Self-tracked Gmail budget is `DAILY_EMAIL_LIMIT = 90` in `Code.js`. A Google **Workspace** account (if the official email is Workspace) raises the real Gmail-send limit to ~1500–2000/day — bump `DAILY_EMAIL_LIMIT` accordingly after migrating, which largely removes the bulk-email bottleneck.
- The overflow **mail queue** (`mailqueue` Sheet tab) + `dailyQueueDrain` trigger move with the script.

## Migration checklist (do on/after 2026-06-20)
- [ ] Get official email creds; confirm if it's Google Workspace (matters for send limits).
- [ ] **Firebase/Firestore (`next-genius-auto`)**: add official account as Owner in IAM, transfer/keep. Update `authDomain` only if project changes (don't if same project).
- [ ] **Cloudflare Pages**: transfer the `next-genius` Pages project to the official CF account (or add as member). Re-add custom domains there.
- [ ] **Domain off Wix**: move DNS to Cloudflare (nameservers) OR set proper apex alias. Then in CF Pages add `next-genius.com` (apex) + `www` → both get certs. Apex SSL fixed here.
- [ ] **Apps Scripts** (sheet-sync + bot): re-own under official account, or change execution identity; update sender/replyTo to official email; re-authorize scopes.
- [ ] **Run `installQueueDrainTrigger` once** under the new owner (this is STILL PENDING even today — see below).
- [ ] Update `replyTo`/sender strings in `next-genius-sheet-sync/Code.js` (currently `nextgeniusindia@gmail.com` / executes as dknmsquad).
- [ ] Re-issue the maintenance token (`ADMIN_TOKEN` Script Property) so the old fallback constant is retired.
- [ ] Verify: signup welcome email, password reset, admin bulk send, reminders all send from the official address.

## STILL PENDING regardless of migration (small)
- **`installQueueDrainTrigger`** has never been run (needs interactive `script.scriptapp` consent; clasp not API-enabled). Until run, queued overflow email (>90/day) won't auto-send. Manual backup: `GET ?drain_queue=1&token=ng_ops_7Qx2m9Lp4Vt8Rk1`. Just fold this into the migration (run it once under the new owner).

## Deploy reminders (unchanged)
- Site: `git push` then manual CF build (`POST .../pages/projects/next-genius/deployments`, Bearer `~/.cloudflare-fm-token`).
- Apps Script: `clasp push -f && clasp deploy -i <deploymentId>` — sheet `AKfycbwVxIhz6N-...PNC7NmT-xQ`, bot `AKfycbzQUQoW6PGd-...X9LSD2I`. Reuse the SAME id or the /exec URL changes.

## Done 2026-06-12 (context)
Full health-check hardening shipped: security tokens, mail queue, admin read cache, student-save retries, sign-in fix. Sheet `applicants` tab reconciled from Firestore (was 509, now 944 rows / 931 unique emails covering all 854 Firestore applicants + ~89 registration-only leads). See `project_next_genius.md` memory for details.
