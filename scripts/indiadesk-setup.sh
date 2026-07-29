#!/usr/bin/env bash
# India Desk - one-time provisioning. Everything else is already in the repo.
#
# NEEDS a Cloudflare API token on the WORK account 869a5c91069a60c128ed30838b881be2
# with:  D1:Edit  +  Cloudflare Pages:Edit  +  Account Settings:Read
# The existing ~/.cloudflare-fm-token is Pages-scope ONLY and cannot make a D1 database.
#
#   export CLOUDFLARE_API_TOKEN=<the new token>
#   export DENVER_EMAIL=<denver's google account>
#   bash scripts/indiadesk-setup.sh
#
# Pages binds secrets at DEPLOY time. The last step redeploys - do not skip it.

set -euo pipefail
cd "$(dirname "$0")/.."

export CLOUDFLARE_ACCOUNT_ID=869a5c91069a60c128ed30838b881be2
PAGES_PROJECT=next-genius
DB=next-genius-indiadesk

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN to a D1+Pages token on the work account}"
: "${DENVER_EMAIL:?set DENVER_EMAIL to the Google account Denver will sign in with}"
: "${INDIADESK_MAINT_TOKEN:?set INDIADESK_MAINT_TOKEN - the same value goes on nm-squad-crm}"

echo "== 1. create the D1 database (skips if it exists)"
npx wrangler d1 create "$DB" || echo "   (already exists, continuing)"

echo "== 2. apply the schema"
npx wrangler d1 execute "$DB" --remote --file=schema/indiadesk.sql --yes

echo "== 3. secrets on the Pages project"
printf '%s' "$DENVER_EMAIL"          | npx wrangler pages secret put INDIADESK_EMAILS      --project-name "$PAGES_PROJECT"
printf '%s' "$INDIADESK_MAINT_TOKEN" | npx wrangler pages secret put INDIADESK_MAINT_TOKEN --project-name "$PAGES_PROJECT"

cat <<'MSG'

== 4. BIND THE DATABASE (dashboard, 30 seconds - the API path is fiddlier than it is worth)
   Cloudflare dashboard -> Workers & Pages -> next-genius -> Settings -> Bindings
   -> Add -> D1 database
        Variable name : INDIADESK_DB
        D1 database   : next-genius-indiadesk
   Add it to BOTH Production and Preview.

== 5. redeploy (GitHub auto-build is broken on this project, so POST it)
   source ~/.cloudflare-fm-token
   curl -s -X POST \
     "https://api.cloudflare.com/client/v4/accounts/869a5c91069a60c128ed30838b881be2/pages/projects/next-genius/deployments" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | head -c 200

== 6. the portal side (nm-squad-crm), same maint token
   cd "/Volumes/T7 Shield/DK-Mac/projects/nm-squad-portal"
   printf '%s' "$INDIADESK_MAINT_TOKEN" | npx wrangler pages secret put INDIADESK_MAINT_TOKEN --project-name nm-squad-crm
   npm run build && npx wrangler pages deploy dist --project-name nm-squad-crm

== 7. check
   https://www.next-genius.com/indiadesk/syracuse   (sign in as Denver)
   https://<portal>/admin/india-desk                (Neeraj/DK: India Desk in the rail)
MSG
