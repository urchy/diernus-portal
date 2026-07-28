#!/usr/bin/env bash
# scripts/seed-staging.sh — create the minimum fixtures the regression test
# needs against a fresh staging D1.
#
# Creates, via the Worker API:
#   - one project owned by cliente.demo
#   - one card in that project (with at least 1 history row from creation)
#   - one 2.5h time entry on that card
#   - one second project + one text/markdown file in it (for the file preview
#     tests; the actual bytes are uploaded to R2 so /api/files/:id works)
#
# Writes the resulting IDs to tests/.staging-fixtures.json so the regression
# script can pick them up. Re-running is safe — each call generates fresh
# IDs, so you'll just end up with multiple "Cadeira L-CH-01 (staging)"
# projects; that's fine.
#
# Idempotency: if the staging D1 already has fixtures, this will just add
# more. Pass --clean to first delete any old "Cadeira L-CH-01 (staging)"
# projects (and their cards/files).

set -euo pipefail

STAGING_API="${STAGING_API:-https://diernus-portal-api-staging.silva-andre-daniel.workers.dev}"
ADMIN_EMAIL="${STAGING_ADMIN_EMAIL:-admin@staging.diernus.com}"
ADMIN_PASSWORD="${STAGING_ADMIN_PASSWORD:-staging2026}"
CLIENT_EMAIL="${STAGING_CLIENT_EMAIL:-cliente.demo@diernus.com}"
PROJECT_NAME="Cadeira L-CH-01 (staging)"
FILE_PROJECT_NAME="Sandbox (staging)"

CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

PY_JSON() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)"; }

COOKIE="$(mktemp)"
trap 'rm -f "$COOKIE" /tmp/seed-proj1.json /tmp/seed-proj1-board.json /tmp/seed-card.json /tmp/seed-entry.json /tmp/seed-proj2.json /tmp/seed-proj2-board.json /tmp/seed-file.json /tmp/seed-file-content.md' EXIT

echo "=== Logging in as $ADMIN_EMAIL ==="
LOGIN_RES=$(curl -s -X POST "$STAGING_API/api/auth/login" \
  -H "Content-Type: application/json" -c "$COOKIE" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
ME=$(echo "$LOGIN_RES" | PY_JSON "['user']['email']")
[ -n "$ME" ] || { echo "✗ login failed: $LOGIN_RES"; exit 1; }
echo "  ✓ $ME"

# Find the cliente.demo user_id
CLIENT_ID=$(curl -s -b "$COOKIE" "$STAGING_API/api/clients" \
  | python3 -c "import sys,json
for c in json.load(sys.stdin)['clients']:
    if c['email'] == '$CLIENT_EMAIL':
        print(c['id']); break")
[ -n "$CLIENT_ID" ] || { echo "✗ client $CLIENT_EMAIL not found"; exit 1; }
echo "  cliente.demo id: $CLIENT_ID"

if [ "$CLEAN" = "1" ]; then
  echo
  echo "=== --clean: deleting any previous '$PROJECT_NAME' projects ==="
  for PID in $(curl -s -b "$COOKIE" "$STAGING_API/api/projects" \
    | python3 -c "import sys,json
for p in json.load(sys.stdin)['projects']:
    if p['name'].startswith('$PROJECT_NAME') or p['name'].startswith('$FILE_PROJECT_NAME'):
        print(p['id'])"); do
    echo "  deleting project $PID"
    curl -s -X DELETE "$STAGING_API/api/projects/$PID" -b "$COOKIE" > /dev/null || true
  done
fi

echo
echo "=== 1. Creating project '$PROJECT_NAME' (owned by $CLIENT_EMAIL) ==="
curl -s -X POST "$STAGING_API/api/projects" -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$CLIENT_ID\",\"name\":\"$PROJECT_NAME\",\"description\":\"Projeto de teste criado pelo seed-staging.sh\"}" \
  > /tmp/seed-proj1.json
HISTORY_PROJECT=$(cat /tmp/seed-proj1.json | PY_JSON "['project']['id']")
echo "  → $HISTORY_PROJECT"

# Board endpoint gives us the default 4 columns. Grab the first one (A Fazer)
echo
echo "=== 2. Fetching the board to get the default columns ==="
curl -s -b "$COOKIE" "$STAGING_API/api/projects/$HISTORY_PROJECT/board" > /tmp/seed-proj1-board.json
COL_ID=$(cat /tmp/seed-proj1-board.json \
  | python3 -c "import sys,json
cols = json.load(sys.stdin)['columns']
print(cols[0]['id'])")
echo "  → column A Fazer: $COL_ID"

echo
echo "=== 3. Creating a card in the project ==="
curl -s -X POST "$STAGING_API/api/projects/$HISTORY_PROJECT/cards" -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -d "{\"column_id\":\"$COL_ID\",\"title\":\"Staging test card\",\"description\":\"Criado pelo seed-staging.sh\",\"priority\":\"high\"}" \
  > /tmp/seed-card.json
ENTRY_CARD=$(cat /tmp/seed-card.json | PY_JSON "['card']['id']")
echo "  → card $ENTRY_CARD"

echo
echo "=== 4. Logging 2.5h on the card (so the time-entry PATCH test has something to edit) ==="
curl -s -X POST "$STAGING_API/api/cards/$ENTRY_CARD/time-entries" -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"hours": 2.5, "note": "staging seed — original"}' > /tmp/seed-entry.json
ENTRY_ID=$(cat /tmp/seed-entry.json | PY_JSON "['entry']['id']")
echo "  → entry $ENTRY_ID (2.5h)"

echo
echo "=== 5. Creating a second project for the file preview tests ==="
curl -s -X POST "$STAGING_API/api/projects" -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$CLIENT_ID\",\"name\":\"$FILE_PROJECT_NAME\"}" \
  > /tmp/seed-proj2.json
FILE_PROJECT=$(cat /tmp/seed-proj2.json | PY_JSON "['project']['id']")
echo "  → $FILE_PROJECT"

echo
echo "=== 6. Uploading a small README.md to that project (real R2 bytes) ==="
# Build a small text file in a temp path. ~400 bytes so we can verify
# the Range bytes=0-99 and Range bytes=-50 headers in the regression.
cat > /tmp/seed-file-content.md <<'README'
# Sandbox (staging)

This is a small README uploaded by seed-staging.sh. The regression test
hits it with several requests:

  - GET /api/files/:id                            (no Range, 200 + attachment)
  - GET /api/files/:id?inline=1                    (200 + inline + Accept-Ranges)
  - GET /api/files/:id?inline=1  Range: bytes=0-99 (206 + Content-Range)
  - GET /api/files/:id?inline=1  Range: bytes=-50 (206 + suffix range)
  - GET /api/files/:id?inline=1  Range: bytes=0-  (206 + open end)
  - GET /api/files/:id?inline=1  Range: bytes=0-999999 (206 + clamped)

If you can read this in a browser preview, the preview feature works.
README
curl -s -X POST "$STAGING_API/api/projects/$FILE_PROJECT/files" -b "$COOKIE" \
  -F "file=@/tmp/seed-file-content.md;type=text/markdown" > /tmp/seed-file.json
FILE_ID=$(cat /tmp/seed-file.json | PY_JSON "['file']['id']")
FILE_SIZE=$(cat /tmp/seed-file.json | PY_JSON "['file']['size']")
echo "  → file $FILE_ID ($FILE_SIZE bytes)"

# Write the JSON the regression script reads
echo
echo "=== Writing tests/.staging-fixtures.json ==="
JSON_FILE="$(cd "$(dirname "$0")/.." && pwd)/tests/.staging-fixtures.json"
cat > "$JSON_FILE" <<EOF
{
  "admin_email":      "$ADMIN_EMAIL",
  "admin_password":   "$ADMIN_PASSWORD",
  "client_email":     "$CLIENT_EMAIL",
  "history_project":  "$HISTORY_PROJECT",
  "history_card":     "$ENTRY_CARD",
  "entry_card":       "$ENTRY_CARD",
  "entry_id":         "$ENTRY_ID",
  "file_id":          "$FILE_ID",
  "file_project":     "$FILE_PROJECT"
}
EOF
echo "  → $JSON_FILE"
cat "$JSON_FILE"

echo
echo "✓ Done. The regression test will pick these IDs up automatically:"
echo "    API=\"$STAGING_API\" WEB=\"https://diernus-portal-staging.pages.dev\" \\"
echo "      bash tests/regression.sh"
