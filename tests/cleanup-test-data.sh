#!/usr/bin/env bash
# tests/cleanup-test-data.sh — wipe test users, test card, and orphan
# invitations from the Diernus Portal D1 database.
#
# Idempotent: safe to re-run. If there's nothing to delete, every step
# is a no-op (the DELETE statements just affect 0 rows).
#
# Targets the REMOTE database by default (matches what production is using).
# Pass --local to target the local dev database instead.

set -euo pipefail

DB_NAME="diernus-portal-db"
REMOTE_FLAG="--remote"
while [ $# -gt 0 ]; do
  case "$1" in
    --local)  REMOTE_FLAG=""; shift ;;
    --remote) shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/../worker"
export PATH="/opt/homebrew/bin:$PATH"

# ---------- what to delete ----------
TEST_EMAILS=(
  "joao.cliente@gmail.com"
  "verify.test@gmail.com"
  "test.notif@gmail.com"
  "silva.andre.daniel@gmail.com"
)
TEST_CARD_ID="900eee35-96be-4f84-88ce-3252614e47fb"

echo "=== Surveying $DB_NAME ($([ -z "$REMOTE_FLAG" ] && echo local || echo remote)) ==="
# Each check is a separate query — keeps the SQL simple and avoids SQLite's
# "too many terms in compound SELECT" limit on deeply-nested IN subqueries.
IN_LIST="'${TEST_EMAILS[0]}','${TEST_EMAILS[1]}','${TEST_EMAILS[2]}','${TEST_EMAILS[3]}'"
report() {  # report <label> <sql>
  local label="$1" sql="$2"
  local n
  n=$(npx wrangler d1 execute "$DB_NAME" --command="$sql" $REMOTE_FLAG 2>&1 \
    | python3 -c "import sys,re, json; m=re.search(r'\"n\":\s*(\d+)|\"COUNT\(\*\) AS n\":\s*(\d+)', sys.stdin.read()); print(m.group(1) or m.group(2) if m else '?')" 2>/dev/null)
  printf '  %-40s %s\n' "$label" "$n"
}
report "test_users"             "SELECT COUNT(*) AS n FROM users WHERE email IN ($IN_LIST);"
report "test_card"              "SELECT COUNT(*) AS n FROM cards WHERE id = '$TEST_CARD_ID';"
report "card_history_for_test_card" "SELECT COUNT(*) AS n FROM card_history WHERE card_id = '$TEST_CARD_ID';"
report "orphan_invitations"     "SELECT COUNT(*) AS n FROM invitations WHERE email NOT IN (SELECT email FROM users);"

echo
echo "=== Press Enter to proceed, Ctrl-C to abort ==="
read -r

echo
echo "=== Deleting the test card (cascades card_history, comments, time_entries, files via card_id) ==="
npx wrangler d1 execute "$DB_NAME" \
  --command="DELETE FROM cards WHERE id = '$TEST_CARD_ID';" $REMOTE_FLAG 2>&1 \
  | grep -E "rows_written|success" | head -2

echo
echo "=== Deleting the 4 test users (cascades invitations, notifications, files via uploaded_by) ==="
# Build the IN clause from the array
IN_LIST="'${TEST_EMAILS[0]}','${TEST_EMAILS[1]}','${TEST_EMAILS[2]}','${TEST_EMAILS[3]}'"
npx wrangler d1 execute "$DB_NAME" \
  --command="DELETE FROM users WHERE email IN ($IN_LIST);" $REMOTE_FLAG 2>&1 \
  | grep -E "rows_written|success" | head -2

echo
echo "=== Cleaning up any orphan invitations (FK to deleted users) ==="
npx wrangler d1 execute "$DB_NAME" \
  --command="DELETE FROM invitations WHERE email NOT IN (SELECT email FROM users);" $REMOTE_FLAG 2>&1 \
  | grep -E "rows_written|success" | head -2

echo
echo "=== Verifying nothing remains ==="
IN_LIST="'${TEST_EMAILS[0]}','${TEST_EMAILS[1]}','${TEST_EMAILS[2]}','${TEST_EMAILS[3]}'"
report() {
  local label="$1" sql="$2"
  local n
  n=$(npx wrangler d1 execute "$DB_NAME" --command="$sql" $REMOTE_FLAG 2>&1 \
    | python3 -c "import sys,re; m=re.search(r'\"n\":\s*(\d+)', sys.stdin.read()); print(m.group(1) if m else '?')" 2>/dev/null)
  printf '  %-40s %s\n' "$label" "$n"
}
report "test_users_remaining"       "SELECT COUNT(*) AS n FROM users WHERE email IN ($IN_LIST);"
report "test_card_remaining"        "SELECT COUNT(*) AS n FROM cards WHERE id = '$TEST_CARD_ID';"
report "history_remaining"          "SELECT COUNT(*) AS n FROM card_history WHERE card_id = '$TEST_CARD_ID';"
report "orphan_invitations_remaining" "SELECT COUNT(*) AS n FROM invitations WHERE email NOT IN (SELECT email FROM users);"

echo
echo "=== Production state ==="
report "users"        "SELECT COUNT(*) AS n FROM users;"
report "projects"     "SELECT COUNT(*) AS n FROM projects;"
report "cards"        "SELECT COUNT(*) AS n FROM cards;"
report "invitations"  "SELECT COUNT(*) AS n FROM invitations;"
report "history"      "SELECT COUNT(*) AS n FROM card_history;"

echo
echo "✓ Done."
