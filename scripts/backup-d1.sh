#!/usr/bin/env bash
# backup-d1.sh — D1 → R2 backup for the Diernus Portal
#
# Modes:
#   (default)         Export prod D1 to a dated SQL file, upload to R2, prune old backups.
#   --list            List existing backups in R2 (most recent first).
#   --restore DATE=   Download a specific backup to ./backups/db-YYYY-MM-DD.sql.
#                     (Then: cd worker && wrangler d1 execute diernus-portal-db --file=...)
#   --env NAME        Override the D1 environment (default: prod). Values: prod | staging.
#   --keep N          Override retention (default: 30 daily backups).
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN   API token with D1:Read + R2:Edit on the diernus account
#   CLOUDFLARE_ACCOUNT_ID  15103fc0f7367d7fc72cab24473dc437
#
# Wrangler reads both from env automatically; we still set them explicitly so the
# script works in CI where wrangler.toml isn't necessarily in the cwd.

set -euo pipefail

# --- config ---
D1_PROD="diernus-portal-db"
D1_STAGING="diernus-portal-db-staging"
R2_BUCKET="diernus-portal-files"
D1_NAME="$D1_PROD"
ENV_LABEL="prod"
KEEP=30
MODE="backup"
RESTORE_DATE=""

# --- arg parse ---
for arg in "$@"; do
  case "$arg" in
    --list)            MODE="list" ;;
    --env=*)           ENV_LABEL="${arg#*=}"; D1_NAME="${arg#*=}" ;;
    --env)             shift; ENV_LABEL="$1"; D1_NAME="$1" ;;
    --keep=*)          KEEP="${arg#*=}" ;;
    --restore=*)       MODE="restore"; RESTORE_DATE="${arg#*=}" ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Env-var overrides (used by GitHub Actions and by `make` targets).
# CLI args take precedence; env vars fill the gaps so the script is
# both shell-friendly and CI-friendly.
[ -n "${ENV:-}" ]        && ENV_LABEL="$ENV" && D1_NAME="$ENV"
[ -n "${ENV_NAME:-}" ]   && ENV_LABEL="$ENV_NAME" && D1_NAME="$ENV_NAME"
[ -n "${KEEP_OVERRIDE:-}" ] && KEEP="$KEEP_OVERRIDE"

case "$ENV_LABEL" in
  prod)    D1_NAME="$D1_PROD";    PREFIX="backups/prod" ;;
  staging) D1_NAME="$D1_STAGING"; PREFIX="backups/staging" ;;
  *) echo "unknown --env: $ENV_LABEL (use prod|staging)" >&2; exit 2 ;;
esac

# --- preflight ---
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

# Locally wrangler is at ./worker/node_modules/.bin/wrangler; in CI it's on PATH.
if [ -x "./worker/node_modules/.bin/wrangler" ]; then
  WR="./worker/node_modules/.bin/wrangler"
elif command -v wrangler >/dev/null 2>&1; then
  WR="wrangler"
else
  echo "wrangler not found (install locally with 'cd worker && npm i' or globally)" >&2
  exit 1
fi

# --- helpers ---
date_utc() { date -u +%Y-%m-%d; }
sha256_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }
bytes_of()  { wc -c < "$1" | tr -d ' '; }

# --- list mode ---
if [ "$MODE" = "list" ]; then
  echo "→ listing backups in r2://$R2_BUCKET/$PREFIX/"
  "$WR" r2 object list "$R2_BUCKET" --prefix "$PREFIX/" --json 2>/dev/null \
    | python3 -c '
import json, sys
data = json.load(sys.stdin)
objs = data.get("objects", data) if isinstance(data, dict) else data
objs = [o for o in objs if o.get("key","").startswith("'"$PREFIX"'/")]
objs.sort(key=lambda o: o.get("key",""), reverse=True)
if not objs:
    print("(no backups yet)")
else:
    print(f"{\"key\":<40} {\"size\":>10}  {\"uploaded\":<20}")
    print("-" * 76)
    for o in objs:
        key = o.get("key","")
        size = o.get("size", 0)
        uploaded = o.get("uploaded","")
        print(f"{key:<40} {size:>10}  {uploaded:<20}")
'
  exit 0
fi

# --- restore mode ---
if [ "$MODE" = "restore" ]; then
  if [ -z "$RESTORE_DATE" ]; then
    echo "--restore needs DATE=YYYY-MM-DD" >&2; exit 2
  fi
  KEY="$PREFIX/${RESTORE_DATE}.sql"
  OUT="./backups/db-${RESTORE_DATE}.sql"
  mkdir -p ./backups
  echo "→ downloading r2://$R2_BUCKET/$KEY → $OUT"
  "$WR" r2 object get "$R2_BUCKET/$KEY" --file "$OUT"
  echo "✓ saved $OUT ($(bytes_of "$OUT") bytes, sha256=$(sha256_of "$OUT" | cut -c1-12))"
  echo
  echo "To restore to prod:"
  echo "  cd worker && wrangler d1 execute $D1_NAME --remote --file=../$OUT"
  exit 0
fi

# --- backup mode (default) ---
DATE="$(date_utc)"
KEY="$PREFIX/${DATE}.sql"
TMP="/tmp/diernus-db-${DATE}.sql"

echo "→ exporting $D1_NAME → $TMP"
"$WR" d1 export "$D1_NAME" --output="$TMP" 2>&1 | grep -v "^$" || true
SIZE=$(bytes_of "$TMP")
SHA=$(sha256_of "$TMP" | cut -c1-12)
echo "✓ exported: $SIZE bytes, sha256=$SHA"

echo "→ uploading r2://$R2_BUCKET/$KEY"
"$WR" r2 object put "$R2_BUCKET/$KEY" --file "$TMP" 2>&1 | tail -5
echo "✓ uploaded $KEY"

# --- prune: keep most recent $KEEP, delete the rest ---
echo "→ pruning (keep most recent $KEEP)"
ALL=$("$WR" r2 object list "$R2_BUCKET" --prefix "$PREFIX/" --json 2>/dev/null \
  | python3 -c '
import json, sys
data = json.load(sys.stdin)
objs = data.get("objects", data) if isinstance(data, dict) else data
objs = [o["key"] for o in objs if o.get("key","").startswith("'"$PREFIX"'/")]
objs.sort(reverse=True)  # YYYY-MM-DD.sql sorts chronologically
print("\n".join(objs))
')
TOTAL=$(echo -n "$ALL" | grep -c . || true)
echo "  found $TOTAL backup(s) under $PREFIX/"
if [ "${TOTAL:-0}" -le "$KEEP" ]; then
  echo "  nothing to prune"
  exit 0
fi
TO_DELETE=$(echo "$ALL" | tail -n +$((KEEP + 1)))
DELETED=0
while IFS= read -r key; do
  [ -z "$key" ] && continue
  "$WR" r2 object delete "$R2_BUCKET/$key" >/dev/null 2>&1 && DELETED=$((DELETED + 1))
  echo "  ✗ deleted $key"
done <<< "$TO_DELETE"
echo "✓ pruned $DELETED old backup(s), kept $KEEP"

# --- cleanup local tmp ---
rm -f "$TMP"
echo "✓ backup complete: r2://$R2_BUCKET/$KEY"
