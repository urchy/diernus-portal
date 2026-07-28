#!/usr/bin/env bash
# scripts/deploy-staging.sh — build + deploy the frontend to the
# diernus-portal-staging Pages project, with the api-base meta tag
# repointed at the staging Worker.
#
# This keeps a clean copy of frontend/ in /tmp, swaps the api-base URL,
# and deploys. Production's frontend/ is never touched.

set -euo pipefail

STAGING_API="${STAGING_API:-https://diernus-portal-api-staging.silva-andre-daniel.workers.dev}"
PROD_API_DEFAULT="https://diernus-portal-api.diernus.com"
STAGE_DIR="$(mktemp -d -t diernus-portal-staging-XXXX)"
trap 'rm -rf "$STAGE_DIR"' EXIT

# Copy the frontend, then rewrite every <meta name="api-base" content="…"> line
# to point at the staging worker. We do it on every HTML file in the project.
echo "→ Staging frontend to $STAGE_DIR (api-base → $STAGING_API)"
cp -R frontend "$STAGE_DIR/frontend"
# Replace the production api-base (in all html files) with the staging one
find "$STAGE_DIR/frontend" -type f -name '*.html' -print0 | xargs -0 \
  perl -i -pe "s|content=\"$PROD_API_DEFAULT\"|content=\"$STAGING_API\"|g"

# Sanity check — at least one html file should have the new api-base
if ! grep -rq "$STAGING_API" "$STAGE_DIR/frontend"; then
  echo "✗ Staging copy did not pick up the new api-base — aborting"
  exit 1
fi
echo "  staged $(find "$STAGE_DIR/frontend" -name '*.html' | wc -l | tr -d ' ') html files"

# Deploy to the staging Pages project
echo
echo "→ Deploying to diernus-portal-staging"
npx wrangler pages deploy "$STAGE_DIR/frontend" \
  --project-name=diernus-portal-staging \
  --commit-dirty=true \
  --branch=main 2>&1 | tail -10

echo
echo "✓ Staging frontend deployed. URL: https://diernus-portal-staging.pages.dev"
echo "  Login with: admin@staging.diernus.com / staging2026"
