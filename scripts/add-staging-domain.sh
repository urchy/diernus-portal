#!/usr/bin/env bash
# scripts/add-staging-domain.sh — attach staging.diernus.com as a custom
# domain on the diernus-portal-staging Pages project.
#
# The Cloudflare wrangler CLI (4.x) doesn't support adding Pages custom
# domains anymore — you have to go through the dashboard. This script
# uses the Cloudflare API directly so you can do it in one command.
#
# Requirements:
#   - CLOUDFLARE_API_TOKEN env var (or in a .env file), with permission
#     to edit Pages projects AND the diernus.com zone
#   - CLOUDFLARE_ACCOUNT_ID (defaults to the one in wrangler.toml)
#
# After running, Pages auto-provisions an SSL cert (~30s) and auto-adds
# the CNAME record to the diernus.com zone (since it's already on
# Cloudflare). So you don't need to touch DNS yourself.

set -euo pipefail

DOMAIN="${DOMAIN:-staging.diernus.com}"
PROJECT="${PROJECT:-diernus-portal-staging}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-15103fc0f7367d7fc72cab24473dc437}"

# Try to load the token from common spots
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ -f .env ]; then
    CLOUDFLARE_API_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | head -1 | cut -d= -f2-)
  fi
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "✗ CLOUDFLARE_API_TOKEN not set"
  echo "  Either:"
  echo "    export CLOUDFLARE_API_TOKEN=...      (in your shell)"
  echo "    echo 'CLOUDFLARE_API_TOKEN=...' > .env (gitignored)"
  echo
  echo "  Get a token at: https://dash.cloudflare.com/profile/api-tokens"
  echo "  Required permissions:"
  echo "    Account > Cloudflare Pages > Edit"
  echo "    Zone > DNS > Edit  (so Pages can auto-add the CNAME)"
  exit 1
fi

echo "=== Adding $DOMAIN to Pages project $PROJECT ==="
RES=$(curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT/domains/" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$DOMAIN\"}")
echo "$RES" | python3 -m json.tool 2>/dev/null || echo "$RES"

if echo "$RES" | grep -q '"success":true'; then
  echo
  echo "✓ Added. Now waiting for SSL cert provisioning..."
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    STATUS=$(curl -s "https://$DOMAIN/" -o /dev/null -w '%{http_code}' 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      echo "✓ $DOMAIN is live (HTTP $STATUS)"
      break
    fi
    echo "  attempt $i: HTTP $STATUS — waiting..."
  done
  echo
  echo "Next steps:"
  echo "  1. Update PUBLIC_URL in worker/wrangler.toml [env.staging] to https://$DOMAIN"
  echo "  2. Redeploy the staging worker:  cd worker && npx wrangler deploy --env staging"
  echo "  3. Re-run the seed:              bash scripts/seed-staging.sh --clean"
  echo "  4. (Optional) add the custom domain alias to scripts/deploy-staging.sh"
else
  echo
  echo "✗ API call failed. Check the response above for details."
  echo "  Common causes:"
  echo "    - Domain already attached (safe to ignore)"
  echo "    - Token missing the Pages:Edit permission"
  echo "    - DNS zone for $DOMAIN not on Cloudflare"
  exit 1
fi
