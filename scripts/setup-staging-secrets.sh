#!/usr/bin/env bash
# scripts/setup-staging-secrets.sh — set the staging worker's secrets
# (RESEND_KEY, Google OAuth) by reading them from stdin or your password
# manager.
#
# Run from the repo root:
#   bash scripts/setup-staging-secrets.sh
#
# You'll be prompted for each one. To skip a secret, press Enter.
# To bulk-set from a file (e.g. your password manager export), pipe it:
#   cat secrets.txt | bash scripts/setup-staging-secrets.sh
#     (one secret per line, in the order shown below)
#
# Existing values are NOT overwritten unless you provide a new one.

set -euo pipefail

cd "$(dirname "$0")/../worker"
export PATH="/opt/homebrew/bin:$PATH"

# Read everything from stdin once (in case the user pipes a file).
INPUT_LINES=()
if [ ! -t 0 ]; then
  while IFS= read -r line; do INPUT_LINES+=("$line"); done
fi
IDX=0

# What we want to set. RESEND_KEY is the only one the staging worker
# strictly needs; the Google OAuth ones are optional (only required if
# you want to test the SSO flow on staging).
SECRETS=(
  "RESEND_KEY:The Resend API key (use the same value as production)"
  "EMAIL_FROM:From-address (defaults to 'Diernus <ola@diernus.com>')"
  "GOOGLE_CLIENT_ID:Google OAuth client ID (optional)"
  "GOOGLE_CLIENT_SECRET:Google OAuth client secret (optional)"
)

echo "=== Current staging secrets ==="
npx wrangler secret list --env staging 2>&1 | grep -E '"' | head -10 || true

echo
echo "=== Setting secrets (Enter to skip, Ctrl-C to abort) ==="
for ENTRY in "${SECRETS[@]}"; do
  KEY="${ENTRY%%:*}"
  DESC="${ENTRY#*:}"
  # Pick up from piped input if available
  if [ "$IDX" -lt "${#INPUT_LINES[@]}" ]; then
    VALUE="${INPUT_LINES[$IDX]}"
    IDX=$((IDX+1))
  else
    read -r -p "  $KEY ($DESC): " VALUE
  fi
  if [ -z "${VALUE:-}" ]; then
    echo "    ↳ skipped (no change)"
    continue
  fi
  if printf '%s' "$VALUE" | npx wrangler secret put "$KEY" --env staging 2>&1 | grep -qE "Success|Uploaded"; then
    echo "    ↳ ✓ $KEY set"
  else
    echo "    ↳ ✗ $KEY failed"
    exit 1
  fi
done

echo
echo "✓ Done. Verify with: cd worker && npx wrangler secret list --env staging"
