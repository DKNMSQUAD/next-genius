# Next Genius — Handoff (updated 2026-05-24)

Local-only doc (git-ignored — do NOT commit; it would be served publicly and leaks internals).
Primary durable store is the assistant memory. This mirrors it for humans.

---

## 1. Custom domain — DONE

- **Primary URL: https://www.next-genius.com** (Cloudflare Pages custom domain, valid SSL).
- Bare **next-genius.com 301-redirects to www** via `functions/_middleware.js` (a Pages Function checks the Host header).
- `https://next-genius.pages.dev` still serves the same project.

How it was done (domain DNS is on **Wix**, registrar Network Solutions, DK has no registrar login):
- `www` CNAME -> `next-genius.pages.dev` set via the **Wix Domains API** (`PATCH https://www.wixapis.com/domains/v1/dns-zones/next-genius.com`, account scope).
- apex A records -> Cloudflare edge IPs `172.66.47.62` / `172.66.44.194` (also via Wix API).
- Both attached to the Pages project `next-genius` (Pages custom-domain API, http validation).
- **Email untouched the entire time** — Google Workspace MX, SPF, DMARC, both Brevo DKIM CNAMEs, Google verification all intact on Wix DNS.
- Firebase Auth authorized domains now include `www.next-genius.com` + `next-genius.com` (added via Identity Toolkit Admin API).

## 2. Interview AI scoring — DONE

Auto-scores the two YouTube interview videos each student submits (Student + Family).

**Pipeline:** `yt-dlp` downloads each video's audio -> Groq **Whisper** (`whisper-large-v3-turbo`) transcribes -> Groq **Llama** (`llama-3.3-70b-versatile`) scores vs a 6-dim scholarship rubric (motivation, communication, academic fit, authenticity, family support, need fit) + overall verdict (strong/consider/weak) + summary + red flags -> writes `interviewEvals/{uid}` (admin-only Firestore collection). All free.

**Runs LOCALLY on this Mac**, not the cloud: YouTube blocks `yt-dlp` from datacenter IPs (GitHub Actions failed every attempt); it works from a residential IP. So:
- Worker script (version-controlled): `~/next-genius/scripts/interview_eval.py`
- Scheduler: launchd `~/Library/LaunchAgents/com.nextgenius.interview.plist` — every 30 min + on load.
- Wrapper + creds: `~/.config/next-genius-worker/run.sh` (holds Groq key, points to `sa.json`). Log: `~/.config/next-genius-worker/worker.log`.
- The GitHub Action `.github/workflows/interview-eval.yml` exists but is **disabled** (cloud can't download). Kept as reference / fallback (works with cookies if ever needed).

**Admin sees it** in `admin.html` applicant detail: video links + scorecard (per-dimension scores, overall badge, summary, red flags, transcripts). Students never see it (separate collection, admin-only read).

Manage the worker:
- Run now: `launchctl kickstart -k gui/$(id -u)/com.nextgenius.interview` (or `bash ~/.config/next-genius-worker/run.sh`)
- Stop: `launchctl unload ~/Library/LaunchAgents/com.nextgenius.interview.plist`
- Logs: `tail ~/.config/next-genius-worker/worker.log`
- Caveat: only runs when the Mac is awake. For 24/7, move to an always-on residential box / proxy (not free).

## 3. DEPLOY GOTCHA (applies to ALL next-genius pushes)

Cloudflare's GitHub auto-build is **broken** for this project. After `git push`, trigger a build manually:
```
source ~/.cloudflare-fm-token
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/869a5c91069a60c128ed30838b881be2/pages/projects/next-genius/deployments" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

## 4. Keys / accounts
- Cloudflare account `869a5c91069a60c128ed30838b881be2`; Pages project `next-genius`. Token: `~/.cloudflare-fm-token` (Pages scope only — cannot create/delete zones or edit DNS).
- Firebase project `next-genius-auto`. Admin SDK SA: `firebase-adminsdk-fbsvc@next-genius-auto.iam.gserviceaccount.com`. Local key: `~/.config/next-genius-worker/sa.json`.
- Groq key (project "next-genius-interview") — in `run.sh` and GitHub repo secret `GROQ_API_KEY`.
- Admin whitelist: `dknmsquad@gmail.com`, `mandhana.neeraj@gmail.com`.

## 5. Cleanup-able (optional, low priority)
- GitHub repo secrets `FIREBASE_SA` + `GROQ_API_KEY` are now unused (cloud worker abandoned). The SA key behind `FIREBASE_SA` is an orphaned credential — safe to delete for hygiene.
