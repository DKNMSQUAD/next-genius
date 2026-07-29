#!/usr/bin/env bash
# India Desk - provisioning. ALREADY DONE on 2026-07-29; kept as the runbook for
# a rebuild, or for opening a second university desk.
#
# Store is Firestore on next-genius-auto, reached with the Admin service account.
# D1 was the first choice (schema/indiadesk.sql still matches the collections
# 1:1) but creating a D1 database needs a Cloudflare token with D1:Edit on the
# work account, and the only token on this Mac is Pages-scope. Firestore needs
# nothing but a Pages secret, so that is the live path.
#
#   export CLOUDFLARE_API_TOKEN=$(source ~/.cloudflare-fm-token; echo "$CLOUDFLARE_API_TOKEN")
#   bash scripts/indiadesk-setup.sh
#
# Pages binds secrets at DEPLOY time. The redeploy at the end is not optional.

set -euo pipefail
cd "$(dirname "$0")/.."

export CLOUDFLARE_ACCOUNT_ID=869a5c91069a60c128ed30838b881be2
PAGES_PROJECT=next-genius
SA=~/.config/next-genius-worker/sa.json

: "${CLOUDFLARE_API_TOKEN:?source ~/.cloudflare-fm-token first}"
: "${INDIADESK_MAINT_TOKEN:?the shared back-office token - the SAME value must be set on nm-squad-crm}"

echo "== 1. the Firebase Admin service account becomes a Pages secret"
python3 -c "import json;print(json.dumps(json.load(open('$SA'))),end='')" \
  | npx wrangler pages secret put FIREBASE_SA --project-name "$PAGES_PROJECT"

echo "== 2. the shared back-office token"
printf '%s' "$INDIADESK_MAINT_TOKEN" \
  | npx wrangler pages secret put INDIADESK_MAINT_TOKEN --project-name "$PAGES_PROJECT"

echo "== 3. desk staff whitelist (comma separated; DK, Neeraj and helpdesk@ are always allowed)"
if [ -n "${INDIADESK_EMAILS:-}" ]; then
  printf '%s' "$INDIADESK_EMAILS" | npx wrangler pages secret put INDIADESK_EMAILS --project-name "$PAGES_PROJECT"
else
  echo "   INDIADESK_EMAILS not set - skipping. Denver cannot sign in until it is."
fi

echo "== 4. redeploy (GitHub auto-build is broken on this project, so POST it)"
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT/deployments" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | head -c 200
echo

cat <<'MSG'

== the portal side (nm-squad-crm, same Cloudflare account, same maint token)
   cd "/Volumes/T7 Shield/DK-Mac/projects/nm-squad-portal"
   printf '%s' "$INDIADESK_MAINT_TOKEN" | npx wrangler pages secret put INDIADESK_MAINT_TOKEN --project-name nm-squad-crm
   rm -rf dist && npm run build && npx wrangler pages deploy dist --project-name nm-squad-crm
   (rm -rf dist matters: a stale hashed asset makes the upload fail with ENOENT)

== check
   https://www.next-genius.com/indiadesk/syracuse    the desk
   https://portal.neerajmandhana.com/admin/india-desk  the back office
MSG
