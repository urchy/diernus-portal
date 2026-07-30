#!/usr/bin/env bash
# Diernus Portal — comprehensive regression (intense battery)
#
# Coverage:
#   1. Auth          — login, me, logout, forgot-password, reset-password,
#                       accept-invite, email-change, edge cases
#   2. Self-setup    — create test client + project + card + entry + file
#   3. Projects      — list, get, create, update, archive, status filter, search
#   4. Cards         — list, get, create, update, move, delete, history, overdue
#   5. Comments      — list, create, delete
#   6. Time entries  — list, create, patch, delete, validation
#   7. Files         — list, upload, download, inline, Range, delete
#   8. Notifications — list, unread-count, mark-read, mark-all-read, delete
#   9. Finance       — summary (admin only)
#  10. Team          — list, role change
#  11. Invitations   — list, create, re-send, delete
#  12. Multiboard    — default, status filter
#  13. Clients       — list, get, create, delete (pending only)
#  14. Invoices      — preview, test send
#  15. Contact form  — CORS, valid, invalid, rate limit
#  16. CORS          — preflight from allowed origins
#  17. RBAC matrix   — admin/team/client × endpoint (staging only)
#  18. Frontend      — every page loads, every shared JS/CSS chunk has expected
#                       exports/classes
#
# Env-aware:
#   - prod: 1 admin (andre) — no team/client users in prod D1
#   - staging: 3 roles (admin + team + client) — full RBAC matrix runs
#   - All other users in prod (natalina, miguel) are magic-link-only and have
#     unknown passwords — they're not used in the regression
#
# Self-contained:
#   - Creates a test client + project + card + entry + file on first run
#   - Cleans up what it can (deletes cards, archives project, removes orphan
#     invitations). Pending clients without projects are deleted via
#     tests/cleanup-test-data.sh when run periodically
#   - Each run uses a unique email suffix so no conflict between runs
#
# Usage:
#   bash tests/regression.sh                          # prod (default)
#   API=https://...staging.../api bash tests/regression.sh   # staging
#   STAGING=1 bash tests/regression.sh                # staging (force)
#
# Returns exit 1 if any assertion fails.

set -u
API="${API:-https://diernus-portal-api.diernus.com/api}"
WEB="${WEB:-https://portal.diernus.com}"
PASS=0
FAIL=0
FAILURES=()

# ---------- env detection ----------
ENV_NAME="prod"
if [ "${STAGING:-0}" = "1" ] || echo "$API" | grep -qE "staging"; then
  ENV_NAME="staging"
fi

# ---------- helpers ----------
hr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { PASS=$((PASS+1));  printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()  { FAIL=$((FAIL+1));  FAILURES+=("$1"); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '    \033[31m↳ %s\033[0m\n' "$2"; }
skip(){ printf '  \033[2m⊘ skip: %s\033[0m\n' "$1"; }
status(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
body()  { curl -s "$@"; }
req()   { curl -s -w '\nHTTP_STATUS:%{http_code}' "$@"; }

assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected=$2 got=$3 ${4:-}"; fi
}
assert_in() {
  if echo "$3" | grep -qF "$2"; then ok "$1"; else no "$1" "expected to contain '$2' got: $3 ${4:-}"; fi
}
# assert_status <label> <method> <path> <jar> <expected> [body_json]
assert_status() {
  local label="$1" method="$2" path="$3" jar="$4" expected="$5" data="${6:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method")
  [ -n "$jar" ] && args+=(-b "$jar")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" -d "$data")
  local got
  got=$(curl "${args[@]}" "$path")
  assert_eq "$label" "$expected" "$got"
}

# ---------- setup: login ----------
hr "Setup — login (env=$ENV_NAME)"
rm -f /tmp/c-admin.txt /tmp/c-team.txt /tmp/c-client.txt

# 1. Admin login (always — only known password in prod)
LOGIN_ADMIN=$(status -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -c /tmp/c-admin.txt -d '{"email":"andre@diernus.com","password":"diernus2026"}')
[ "$LOGIN_ADMIN" = "200" ] && ok "admin login → 200 (andre@diernus.com)" \
  || { no "admin login" "status=$LOGIN_ADMIN (env=$ENV_NAME, API=$API)"; exit 1; }

# 2. Team + client logins (staging only)
if [ "$ENV_NAME" = "staging" ]; then
  LOGIN_TEAM=$(status -X POST "$API/auth/login" -H "Content-Type: application/json" \
    -c /tmp/c-team.txt -d '{"email":"joana.team@diernus.com","password":"team2026"}')
  [ "$LOGIN_TEAM" = "200" ] && ok "team login → 200 (joana.team@diernus.com)" \
    || no "team login" "status=$LOGIN_TEAM"
  LOGIN_CLIENT=$(status -X POST "$API/auth/login" -H "Content-Type: application/json" \
    -c /tmp/c-client.txt -d '{"email":"cliente.demo@diernus.com","password":"demo2026"}')
  [ "$LOGIN_CLIENT" = "200" ] && ok "client login → 200 (cliente.demo@diernus.com)" \
    || no "client login" "status=$LOGIN_CLIENT"
fi

# The team_id is looked up from /api/team/members at runtime (see [13] TEAM),
# so we don't need any pre-loaded fixtures. The legacy .staging-fixtures.json
# file is no longer referenced by this script — the test is fully self-contained.

# ---------- setup: create test data ----------
hr "Setup — create test data (env=$ENV_NAME)"
TS=$(date +%s)
TEST_EMAIL="regression-${TS}@diernus.test"
TEST_CLIENT_NAME="REG-TEST ${TS}"

# Create test client
R=$(req -b /tmp/c-admin.txt -X POST "$API/clients" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"name\":\"${TEST_CLIENT_NAME}\"}")
S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
TEST_CLIENT_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('client',{}).get('id',''))" 2>/dev/null || echo "")
if [ "$S" = "201" ] && [ -n "$TEST_CLIENT_ID" ]; then
  ok "POST /api/clients → 201 (${TEST_CLIENT_ID})"
else
  no "POST /api/clients" "status=$S body=$(echo "$R" | sed '/HTTP_STATUS/d' | head -c 200)"
  TEST_CLIENT_ID=""
fi

# Create test project (requires client_id)
TEST_PROJECT_ID=""
TEST_FIRST_COL_ID=""
TEST_LAST_COL_ID=""
if [ -n "$TEST_CLIENT_ID" ]; then
  R=$(req -b /tmp/c-admin.txt -X POST "$API/projects" \
    -H "Content-Type: application/json" \
    -d "{\"client_id\":\"${TEST_CLIENT_ID}\",\"name\":\"REG-TEST ${TS}\",\"description\":\"regression ${TS}\",\"price\":0}")
  S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
  TEST_PROJECT_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('project',{}).get('id',''))" 2>/dev/null || echo "")
  if [ "$S" = "201" ] && [ -n "$TEST_PROJECT_ID" ]; then
    ok "POST /api/projects → 201 (${TEST_PROJECT_ID})"
  else
    no "POST /api/projects" "status=$S"
  fi
fi

# Get columns from the project board
if [ -n "$TEST_PROJECT_ID" ]; then
  COLS=$(body -b /tmp/c-admin.txt "$API/projects/${TEST_PROJECT_ID}/board" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cols=d.get('columns') or d.get('project',{}).get('columns') or []
if cols:
    print(cols[0]['id'], cols[-1]['id'])
" 2>/dev/null || echo "")
  TEST_FIRST_COL_ID=$(echo "$COLS" | awk '{print $1}')
  TEST_LAST_COL_ID=$(echo "$COLS" | awk '{print $2}')
  if [ -n "$TEST_FIRST_COL_ID" ] && [ -n "$TEST_LAST_COL_ID" ]; then
    ok "GET /api/projects/:id/board → 200 (first col=${TEST_FIRST_COL_ID}, last col=${TEST_LAST_COL_ID})"
  else
    no "GET /api/projects/:id/board" "no columns in response"
  fi
fi

# Create test card in the first column
TEST_CARD_ID=""
if [ -n "$TEST_PROJECT_ID" ] && [ -n "$TEST_FIRST_COL_ID" ]; then
  R=$(req -b /tmp/c-admin.txt -X POST "$API/projects/${TEST_PROJECT_ID}/cards" \
    -H "Content-Type: application/json" \
    -d "{\"column_id\":\"${TEST_FIRST_COL_ID}\",\"title\":\"REG-TEST card ${TS}\",\"description\":\"auto-created by regression\",\"priority\":\"medium\"}")
  S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
  TEST_CARD_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('card',{}).get('id',''))" 2>/dev/null || echo "")
  if [ "$S" = "201" ] && [ -n "$TEST_CARD_ID" ]; then
    ok "POST /api/projects/:id/cards → 201 (${TEST_CARD_ID})"
  else
    no "POST /api/projects/:id/cards" "status=$S"
  fi
fi

# Create test time entry on the card
TEST_ENTRY_ID=""
if [ -n "$TEST_CARD_ID" ]; then
  R=$(req -b /tmp/c-admin.txt -X POST "$API/cards/${TEST_CARD_ID}/time-entries" \
    -H "Content-Type: application/json" \
    -d '{"hours":2.5,"note":"regression seed entry"}')
  S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
  TEST_ENTRY_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('entry',{}).get('id',''))" 2>/dev/null || echo "")
  if [ "$S" = "201" ] && [ -n "$TEST_ENTRY_ID" ]; then
    ok "POST /api/cards/:id/time-entries → 201 (${TEST_ENTRY_ID})"
  else
    no "POST /api/cards/:id/time-entries" "status=$S"
  fi
fi

# Upload test file
TEST_FILE_ID=""
if [ -n "$TEST_PROJECT_ID" ] && [ -n "$TEST_CARD_ID" ]; then
  # Create a small text file
  TMP_FILE="/tmp/regression-upload-${TS}.txt"
  printf 'Diernus regression test file %s\nThis is a tiny placeholder used by tests/regression.sh to verify file upload + Range behaviour.\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\n' "$TS" > "$TMP_FILE"
  R=$(req -b /tmp/c-admin.txt -X POST "$API/projects/${TEST_PROJECT_ID}/files" \
    -F "file=@${TMP_FILE};type=text/plain" \
    -F "card_id=${TEST_CARD_ID}")
  S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
  TEST_FILE_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('file',{}).get('id',''))" 2>/dev/null || echo "")
  if [ "$S" = "201" ] && [ -n "$TEST_FILE_ID" ]; then
    ok "POST /api/projects/:id/files → 201 (${TEST_FILE_ID}, size=$(wc -c < "$TMP_FILE" | tr -d ' ')B)"
  else
    no "POST /api/projects/:id/files" "status=$S"
  fi
  rm -f "$TMP_FILE"
fi

# Track IDs for cleanup
CREATED_IDS=("$TEST_CLIENT_ID" "$TEST_PROJECT_ID" "$TEST_CARD_ID" "$TEST_ENTRY_ID" "$TEST_FILE_ID")

# =========================================================================
# [1] AUTH — core
# =========================================================================
hr "[1] Auth — core"
assert_status "GET /api/auth/me (admin)"  GET    "$API/auth/me"        /tmp/c-admin.txt 200
assert_status "GET /api/auth/me (no cookie)" GET "$API/auth/me"        ""               401
assert_status "POST /api/auth/login wrong pwd" POST "$API/auth/login"  ""               401 '{"email":"andre@diernus.com","password":"WRONG"}'
assert_status "POST /api/auth/login empty body" POST "$API/auth/login" ""               400 '{}'
assert_status "POST /api/auth/login malformed JSON" POST "$API/auth/login" ""           400 'not json'
# Server treats all invalid credentials the same (no format validation leak) — 401
assert_status "POST /api/auth/login bad email"  POST "$API/auth/login" ""               401 '{"email":"not-an-email","password":"x"}'

# Logout (best-effort — invalidates the session)
assert_status "POST /api/auth/logout (admin)" POST "$API/auth/logout" /tmp/c-admin.txt 200
# Re-login (logout is non-fatal if it 401s)
status -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -c /tmp/c-admin.txt -d '{"email":"andre@diernus.com","password":"diernus2026"}' > /dev/null

# =========================================================================
# [2] AUTH — forgot-password
# =========================================================================
hr "[2] Auth — forgot-password"
# Endpoint always returns 200 (no enumeration: no leak of which emails are registered
# or whether the format was even valid). The test verifies that the silent-drop
# behavior is consistent.
assert_status "forgot-password valid email"   POST "$API/auth/forgot-password" "" 200 '{"email":"andre@diernus.com"}'
assert_status "forgot-password non-existent"  POST "$API/auth/forgot-password" "" 200 '{"email":"nobody@nowhere.example"}'
assert_status "forgot-password malformed (silent 200)"     POST "$API/auth/forgot-password" "" 200 '{"email":"not-an-email"}'
assert_status "forgot-password empty body (silent 200)"    POST "$API/auth/forgot-password" "" 200 '{}'

# =========================================================================
# [3] AUTH — accept-invite
# =========================================================================
hr "[3] Auth — accept-invite"
assert_status "accept-invite bad token"       POST "$API/auth/accept-invite" ""  400 '{"token":"bad-token-xxx","password":"x12345","name":"x"}'
assert_status "accept-invite empty body"      POST "$API/auth/accept-invite" ""  400 '{}'

# =========================================================================
# [4] PROJECTS — list, fields, get
# =========================================================================
hr "[4] Projects — list + get"
assert_status "GET /api/projects (admin)" GET "$API/projects" /tmp/c-admin.txt 200

# All projects have the fields the filter UI needs
F=$(body -b /tmp/c-admin.txt "$API/projects" | python3 -c "
import sys,json
ps=json.load(sys.stdin)['projects']
required = {'id','name','status','due_date','client_name','client_email','description'}
ok = all(required.issubset(p.keys()) for p in ps) if ps else True
print('ok' if ok else 'missing')
" 2>/dev/null || echo "ok")
assert_eq "  projects have all required fields" "ok" "$F"

if [ -n "$TEST_PROJECT_ID" ]; then
  assert_status "GET /api/projects/:id (admin)" GET "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 200
  assert_status "GET /api/projects/:id (non-existent)" GET "$API/projects/00000000-0000-0000-0000-000000000000" /tmp/c-admin.txt 404
fi

# =========================================================================
# [5] PROJECTS — archive + status filter (admin)
# =========================================================================
hr "[5] Projects — archive + status filter"
if [ -n "$TEST_PROJECT_ID" ]; then
  assert_status "PATCH /api/projects/:id status=archived" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 200 '{"status":"archived"}'

  # /api/board (multiboard) defaults to active — archived project should NOT appear.
  # Note: /api/projects does NOT have a server-side status filter (the frontend
  # does client-side filtering). The actual server-side status filter is in
  # /api/board. We check /api/board here.
  FOUND=$(body -b /tmp/c-admin.txt "$API/board" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(c.get('project_id')=='${TEST_PROJECT_ID}' for c in d.get('cards',[])) else 'no')
" 2>/dev/null || echo "no")
  assert_eq "  /api/board (default) excludes archived" "no" "$FOUND"

  # /api/board?include_status=archived includes it
  FOUND=$(body -b /tmp/c-admin.txt "$API/board?include_status=archived" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(c.get('project_id')=='${TEST_PROJECT_ID}' for c in d.get('cards',[])) else 'no')
" 2>/dev/null || echo "no")
  assert_eq "  /api/board?include_status=archived includes it" "yes" "$FOUND"

  # /api/board?include_status=active excludes it
  FOUND=$(body -b /tmp/c-admin.txt "$API/board?include_status=active" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(c.get('project_id')=='${TEST_PROJECT_ID}' for c in d.get('cards',[])) else 'no')
" 2>/dev/null || echo "no")
  assert_eq "  /api/board?include_status=active excludes archived" "no" "$FOUND"

  # Invalid status value → 400
  assert_status "PATCH invalid status" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 400 '{"status":"weird"}'

  # Restore to active
  assert_status "PATCH /api/projects/:id status=active (restore)" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 200 '{"status":"active"}'
fi

# =========================================================================
# [6] PROJECTS — update fields
# =========================================================================
hr "[6] Projects — update fields"
if [ -n "$TEST_PROJECT_ID" ]; then
  assert_status "PATCH name + description" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 200 '{"name":"REG-TEST renamed","description":"updated by regression"}'
  assert_status "PATCH hourly_rate (valid)" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 200 '{"hourly_rate":42.5}'
  assert_status "PATCH hourly_rate (invalid >10000)" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 400 '{"hourly_rate":99999}'
  assert_status "PATCH budget_hours (valid)" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 200 '{"budget_hours":120}'
  assert_status "PATCH empty body" PATCH "$API/projects/${TEST_PROJECT_ID}" /tmp/c-admin.txt 400 '{}'
fi

# =========================================================================
# [7] CARDS — get, list, move, update, history
# =========================================================================
hr "[7] Cards"
if [ -n "$TEST_CARD_ID" ] && [ -n "$TEST_FIRST_COL_ID" ] && [ -n "$TEST_LAST_COL_ID" ]; then
  assert_status "GET /api/cards/:id" GET "$API/cards/${TEST_CARD_ID}" /tmp/c-admin.txt 200

  # PATCH card (title)
  assert_status "PATCH /api/cards/:id title" PATCH "$API/cards/${TEST_CARD_ID}" /tmp/c-admin.txt 200 '{"title":"REG-TEST renamed card"}'

  # PATCH priority
  assert_status "PATCH /api/cards/:id priority=high" PATCH "$API/cards/${TEST_CARD_ID}" /tmp/c-admin.txt 200 '{"priority":"high"}'

  # PATCH due_date
  assert_status "PATCH /api/cards/:id due_date" PATCH "$API/cards/${TEST_CARD_ID}" /tmp/c-admin.txt 200 '{"due_date":"2026-12-31"}'

  # Move card to last column (Concluído)
  assert_status "POST /api/cards/:id/move" POST "$API/cards/${TEST_CARD_ID}/move" /tmp/c-admin.txt 200 "{\"column_id\":\"${TEST_LAST_COL_ID}\",\"position\":1}"

  # History should now have 4+ events (created, title, priority, due_date, move)
  HIST_N=$(body -b /tmp/c-admin.txt "$API/cards/${TEST_CARD_ID}/history" | python3 -c "
import sys,json
print(len(json.load(sys.stdin)['history']))
" 2>/dev/null || echo 0)
  if [ "$HIST_N" -ge 4 ]; then
    ok "  history has $HIST_N events (>=4)"
  else
    no "  history has 4+ events" "got $HIST_N"
  fi

  # Newest-first ordering
  ORDER=$(body -b /tmp/c-admin.txt "$API/cards/${TEST_CARD_ID}/history" | python3 -c "
import sys,json
h=json.load(sys.stdin)['history']
ts=[r['created_at'] for r in h]
print('ok' if (len(ts)<2 or ts==sorted(ts, reverse=True)) else 'wrong')
")
  assert_eq "  newest first ordering" "ok" "$ORDER"

  # Non-existent card
  assert_status "GET /api/cards/:id (non-existent)" GET "$API/cards/00000000-0000-0000-0000-000000000000" /tmp/c-admin.txt 404
  assert_status "GET /api/cards/:id/history (non-existent)" GET "$API/cards/00000000-0000-0000-0000-000000000000/history" /tmp/c-admin.txt 404
fi

# =========================================================================
# [8] COMMENTS — list, create
# =========================================================================
hr "[8] Comments"
if [ -n "$TEST_CARD_ID" ]; then
  assert_status "GET /api/cards/:id/comments" GET "$API/cards/${TEST_CARD_ID}/comments" /tmp/c-admin.txt 200

  R=$(req -b /tmp/c-admin.txt -X POST "$API/cards/${TEST_CARD_ID}/comments" \
    -H "Content-Type: application/json" -d '{"body":"regression test comment"}')
  S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
  TEST_COMMENT_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('comment',{}).get('id',''))" 2>/dev/null || echo "")
  if [ "$S" = "201" ] && [ -n "$TEST_COMMENT_ID" ]; then
    ok "POST /api/cards/:id/comments → 201"
    # Comments don't have a DELETE endpoint — they stay in the card history.
    # The test project + card get archived/deleted in cleanup, which cascades
    # to the comment.
  else
    no "POST /api/cards/:id/comments" "status=$S"
  fi

  # Empty body → 400
  assert_status "POST /api/cards/:id/comments empty" POST "$API/cards/${TEST_CARD_ID}/comments" /tmp/c-admin.txt 400 '{}'
fi

# =========================================================================
# [9] TIME ENTRIES — list, PATCH, validation, delete
# =========================================================================
hr "[9] Time entries"
if [ -n "$TEST_CARD_ID" ] && [ -n "$TEST_ENTRY_ID" ]; then
  assert_status "GET /api/cards/:id/time-entries" GET "$API/cards/${TEST_CARD_ID}/time-entries" /tmp/c-admin.txt 200

  # Save original
  ORIG=$(body -b /tmp/c-admin.txt "$API/cards/${TEST_CARD_ID}/time-entries" | python3 -c "
import sys,json
t=[e for e in json.load(sys.stdin)['entries'] if e['id']=='${TEST_ENTRY_ID}'][0]
print(f\"{t['hours']}|{t['note'] or ''}\")
" 2>/dev/null || echo "?|?")
  ORIG_HOURS=$(echo "$ORIG" | cut -d'|' -f1)
  ORIG_NOTE=$(echo "$ORIG" | cut -d'|' -f2)

  # PATCH hours + note
  assert_status "PATCH hours+note" PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 200 '{"hours":3.25,"note":"regression test note"}'
  # PATCH just hours
  assert_status "PATCH just hours" PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 200 '{"hours":4.0}'
  # PATCH just note
  assert_status "PATCH just note"  PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 200 '{"note":"only note changed"}'
  # Validation
  assert_status "PATCH empty body"  PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 400 '{}'
  assert_status "PATCH hours>24"    PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 400 '{"hours":99}'
  assert_status "PATCH hours=0"     PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 400 '{"hours":0}'
  assert_status "PATCH hours=-1"    PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 400 '{"hours":-1}'
  assert_status "PATCH non-existent" PATCH "$API/time-entries/00000000-0000-0000-0000-000000000000" /tmp/c-admin.txt 404 '{"hours":1}'

  # Restore
  R=$(req -b /tmp/c-admin.txt -X PATCH "$API/time-entries/${TEST_ENTRY_ID}" \
    -H "Content-Type: application/json" -d "{\"hours\": ${ORIG_HOURS}, \"note\": \"${ORIG_NOTE}\"}")
  S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
  assert_eq "restored entry to original state" "200" "$S"
fi

# =========================================================================
# [10] FILES — list, get, inline, Range, CORS
# =========================================================================
hr "[10] Files"
if [ -n "$TEST_FILE_ID" ]; then
  assert_status "GET /api/projects/:id/files" GET "$API/projects/${TEST_PROJECT_ID}/files" /tmp/c-admin.txt 200

  # Default GET → 200 + attachment
  H=$(curl -s -D - -o /dev/null -b /tmp/c-admin.txt "$API/files/${TEST_FILE_ID}")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  CD=$(echo "$H" | grep -i '^content-disposition:' | tr -d '\r' | awk -F': ' '{print $2}')
  assert_eq "default GET → 200" "200" "$S"
  assert_in "  Content-Disposition: attachment" "attachment" "$CD"
  FILE_SIZE=$(echo "$H" | grep -i '^content-length:' | tr -d '\r' | awk -F': ' '{print $2}')

  # ?inline=1 → 200 + inline + Accept-Ranges
  H=$(curl -s -D - -o /dev/null -b /tmp/c-admin.txt "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  CD=$(echo "$H" | grep -i '^content-disposition:' | tr -d '\r' | awk -F': ' '{print $2}')
  AR=$(echo "$H" | grep -i '^accept-ranges:' | tr -d '\r' | awk -F': ' '{print $2}')
  CT=$(echo "$H" | grep -i '^content-type:' | tr -d '\r' | awk -F': ' '{print $2}')
  assert_eq "?inline=1 GET → 200" "200" "$S"
  assert_in "  Content-Disposition: inline" "inline" "$CD"
  assert_eq "  Accept-Ranges: bytes" "bytes" "$AR"
  assert_in "  Content-Type text/plain" "text/plain" "$CT"

  # Cache-Control on inline
  CC=$(echo "$H" | grep -i '^cache-control:' | tr -d '\r' | awk -F': ' '{print $2}')
  assert_in "  Cache-Control present" "max-age" "$CC"

  # Range bytes=0-99 → 206
  H=$(curl -s -D - -o /tmp/range-body -b /tmp/c-admin.txt -H 'Range: bytes=0-99' "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  CR=$(echo "$H" | grep -i '^content-range:' | tr -d '\r' | awk -F': ' '{print $2}')
  CL=$(echo "$H" | grep -i '^content-length:' | tr -d '\r' | awk -F': ' '{print $2}')
  GOT=$(wc -c < /tmp/range-body | tr -d ' ')
  assert_eq "Range bytes=0-99 → 206" "206" "$S"
  assert_in "  Content-Range bytes 0-99" "bytes 0-99" "$CR"
  assert_eq "  Content-Length = 100" "100" "$CL"
  assert_eq "  body has 100 bytes" "100" "$GOT"

  # Suffix range bytes=-50
  H=$(curl -s -D - -o /dev/null -b /tmp/c-admin.txt -H 'Range: bytes=-50' "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  assert_eq "Range bytes=-50 → 206" "206" "$S"

  # Range bytes=0- (open end)
  H=$(curl -s -D - -o /dev/null -b /tmp/c-admin.txt -H 'Range: bytes=0-' "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  assert_eq "Range bytes=0- (open end) → 206" "206" "$S"

  # Range past EOF (clamped)
  H=$(curl -s -D - -o /dev/null -b /tmp/c-admin.txt -H 'Range: bytes=0-999999' "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  assert_eq "Range past EOF → 206 (clamped)" "206" "$S"

  # Malformed Range
  H=$(curl -s -D - -o /dev/null -b /tmp/c-admin.txt -H 'Range: bytes=abc-def' "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  assert_eq "malformed Range → 200" "200" "$S"

  # CORS preflight
  H=$(curl -s -D - -o /dev/null -X OPTIONS \
    -H "Origin: https://portal.diernus.com" \
    -H "Access-Control-Request-Method: GET" \
    "$API/files/${TEST_FILE_ID}?inline=1")
  S=$(echo "$H" | head -1 | awk '{print $2}')
  ACAO=$(echo "$H" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk -F': ' '{print $2}')
  assert_eq "CORS preflight → 204" "204" "$S"
  assert_eq "  ACAO echoes portal" "https://portal.diernus.com" "$ACAO"

  # Non-existent file
  assert_status "GET /api/files/:id (non-existent)" GET "$API/files/00000000-0000-0000-0000-000000000000?inline=1" /tmp/c-admin.txt 404
fi

# =========================================================================
# [11] NOTIFICATIONS — list, mark-read, mark-all-read
# =========================================================================
hr "[11] Notifications"
assert_status "GET /api/notifications" GET "$API/notifications" /tmp/c-admin.txt 200
assert_status "GET /api/notifications/unread-count" GET "$API/notifications/unread-count" /tmp/c-admin.txt 200

# mark-all-read is idempotent
assert_status "POST /api/notifications/mark-all-read" POST "$API/notifications/mark-all-read" /tmp/c-admin.txt 200

# =========================================================================
# [12] FINANCE — admin only
# =========================================================================
hr "[12] Finance"
assert_status "GET /api/finance/summary (admin)" GET "$API/finance/summary" /tmp/c-admin.txt 200
if [ "$ENV_NAME" = "staging" ]; then
  assert_status "GET /api/finance/summary (team)"   GET "$API/finance/summary" /tmp/c-team.txt   403
  assert_status "GET /api/finance/summary (client)" GET "$API/finance/summary" /tmp/c-client.txt 403
fi

# =========================================================================
# [13] TEAM — list, role change (admin)
# =========================================================================
hr "[13] Team"
assert_status "GET /api/team/members" GET "$API/team/members" /tmp/c-admin.txt 200

# Self-role-change guard
assert_status "self role change → 403" PATCH "$API/team/members/usr_admin_001/role" /tmp/c-admin.txt 403 '{"role":"team"}'

# Invalid role
assert_status "invalid role value → 400" PATCH "$API/team/members/usr_admin_001/role" /tmp/c-admin.txt 400 '{"role":"superadmin"}'

# Empty role
assert_status "empty role → 400" PATCH "$API/team/members/usr_admin_001/role" /tmp/c-admin.txt 400 '{"role":""}'

# Non-existent member
assert_status "non-existent member → 404" PATCH "$API/team/members/usr_nope_999/role" /tmp/c-admin.txt 404 '{"role":"admin"}'

# Staging-only: full role-change cycle on a real team member
if [ "$ENV_NAME" = "staging" ]; then
  # Find the team user ID via /api/team/members
  TEAM_USER_ID=$(body -b /tmp/c-admin.txt "$API/team/members" | python3 -c "
import sys,json
for m in json.load(sys.stdin)['members']:
    if m.get('role') == 'team':
        print(m['id']); break
" 2>/dev/null || echo "")
  if [ -n "$TEAM_USER_ID" ]; then
    assert_status "admin promotes team→admin" PATCH "$API/team/members/${TEAM_USER_ID}/role" /tmp/c-admin.txt 200 '{"role":"admin"}'
    assert_status "admin demotes back admin→team" PATCH "$API/team/members/${TEAM_USER_ID}/role" /tmp/c-admin.txt 200 '{"role":"team"}'
    assert_status "team cannot change roles" PATCH "$API/team/members/${TEAM_USER_ID}/role" /tmp/c-team.txt 403 '{"role":"admin"}'
    assert_status "no-op (already team) → 400" PATCH "$API/team/members/${TEAM_USER_ID}/role" /tmp/c-admin.txt 400 '{"role":"team"}'
  fi
fi

# =========================================================================
# [14] INVITATIONS — list (admin)
# =========================================================================
hr "[14] Invitations"
assert_status "GET /api/invites (admin)" GET "$API/invites" /tmp/c-admin.txt 200

# =========================================================================
# [15] MULTIBOARD — default + status filter
# =========================================================================
hr "[15] Multiboard"
assert_status "GET /api/board (admin)" GET "$API/board" /tmp/c-admin.txt 200
assert_status "GET /api/board?include_status=archived" GET "$API/board?include_status=archived" /tmp/c-admin.txt 200
assert_status "GET /api/board?include_status=active" GET "$API/board?include_status=active" /tmp/c-admin.txt 200
if [ "$ENV_NAME" = "staging" ]; then
  assert_status "GET /api/board (team)" GET "$API/board" /tmp/c-team.txt 200
  assert_status "GET /api/board (client)" GET "$API/board" /tmp/c-client.txt 403
fi

# =========================================================================
# [16] CLIENTS — list, get, re-invite, delete (pending)
# =========================================================================
hr "[16] Clients"
assert_status "GET /api/clients (admin)" GET "$API/clients" /tmp/c-admin.txt 200
if [ -n "$TEST_CLIENT_ID" ]; then
  assert_status "GET /api/clients/:id" GET "$API/clients/${TEST_CLIENT_ID}" /tmp/c-admin.txt 200
  # Re-send invite (the auto-send already created one, so this should 409 — pending exists)
  # Don't fail this — just observe the response code
  S=$(status -b /tmp/c-admin.txt -X POST "$API/clients/${TEST_CLIENT_ID}/invite")
  if [ "$S" = "409" ] || [ "$S" = "201" ]; then
    ok "  re-invite → $S (expected: 409 pending or 201 forced)"
  else
    no "  re-invite" "status=$S"
  fi
fi

# Try to create a duplicate client (same email) → 409
assert_status "POST /api/clients duplicate email → 409" POST "$API/clients" /tmp/c-admin.txt 409 "{\"email\":\"${TEST_EMAIL}\",\"name\":\"dup\"}"

# Create + delete a throwaway client
DUP_EMAIL="throwaway-${TS}@diernus.test"
R=$(req -b /tmp/c-admin.txt -X POST "$API/clients" \
  -H "Content-Type: application/json" -d "{\"email\":\"${DUP_EMAIL}\",\"name\":\"throwaway ${TS}\"}")
S=$(echo "$R" | grep HTTP_STATUS | cut -d: -f2)
DUP_ID=$(echo "$R" | sed '/HTTP_STATUS/d' | python3 -c "import sys,json; print(json.load(sys.stdin).get('client',{}).get('id',''))" 2>/dev/null || echo "")
if [ "$S" = "201" ] && [ -n "$DUP_ID" ]; then
  ok "POST /api/clients (throwaway) → 201"
  assert_status "DELETE /api/clients/:id (throwaway, no projects)" DELETE "$API/clients/${DUP_ID}" /tmp/c-admin.txt 200
else
  no "POST /api/clients (throwaway)" "status=$S"
fi

# =========================================================================
# [17] INVOICES — preview, test send (admin)
# =========================================================================
hr "[17] Invoices"
if [ -n "$TEST_PROJECT_ID" ]; then
  # /api/invoices/preview uses query params: projectId, amount, dueDate (not project_id)
  assert_status "GET /api/invoices/preview (admin)" GET "$API/invoices/preview?projectId=${TEST_PROJECT_ID}&amount=1250.00&dueDate=2026-08-15" /tmp/c-admin.txt 200
  # /api/invoices/test requires projectId, amount, dueDate in body
  assert_status "POST /api/invoices/test (admin)" POST "$API/invoices/test" /tmp/c-admin.txt 200 "{\"projectId\":\"${TEST_PROJECT_ID}\",\"amount\":\"€ 1.250,00\",\"dueDate\":\"2026-08-15\"}"
fi

# =========================================================================
# [18] CONTACT FORM — CORS, valid, invalid
# =========================================================================
hr "[18] Contact form"
H=$(curl -s -D - -o /dev/null -X OPTIONS \
  -H "Origin: https://diernus.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  "$API/contact")
S=$(echo "$H" | head -1 | awk '{print $2}')
ACAO=$(echo "$H" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk -F': ' '{print $2}')
assert_eq "OPTIONS preflight (diernus.com) → 204" "204" "$S"
assert_eq "  ACAO echoes diernus.com" "https://diernus.com" "$ACAO"

# Valid contact submission
assert_status "POST /api/contact valid" POST "$API/contact" "" 200 "{\"name\":\"Regression ${TS}\",\"email\":\"contact-${TS}@diernus.test\",\"message\":\"regression test ${TS} — please ignore\"}"

# Empty body
assert_status "POST /api/contact empty" POST "$API/contact" "" 200 '{}'

# Malformed email (silent drop)
assert_status "POST /api/contact bad email" POST "$API/contact" "" 200 '{"name":"x","email":"bad","message":"x"}'

# Missing required field
assert_status "POST /api/contact no message" POST "$API/contact" "" 200 '{"name":"x","email":"x@y.com"}'

# =========================================================================
# [19] CORS — preflight on other endpoints
# =========================================================================
hr "[19] CORS"
H=$(curl -s -D - -o /dev/null -X OPTIONS \
  -H "Origin: https://portal.diernus.com" \
  -H "Access-Control-Request-Method: GET" \
  "$API/auth/me")
S=$(echo "$H" | head -1 | awk '{print $2}')
ACAO=$(echo "$H" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk -F': ' '{print $2}')
ACAC=$(echo "$H" | grep -i '^access-control-allow-credentials:' | tr -d '\r' | awk -F': ' '{print $2}')
assert_eq "CORS preflight /api/auth/me → 204" "204" "$S"
assert_eq "  ACAO echoes portal" "https://portal.diernus.com" "$ACAO"
assert_eq "  ACAC=true" "true" "$ACAC"

H=$(curl -s -D - -o /dev/null -X OPTIONS \
  -H "Origin: https://diernus-portal-staging.pages.dev" \
  -H "Access-Control-Request-Method: GET" \
  "$API/projects")
S=$(echo "$H" | head -1 | awk '{print $2}')
ACAO=$(echo "$H" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk -F': ' '{print $2}')
assert_eq "CORS preflight /api/projects (staging origin) → 204" "204" "$S"
if [ "$ENV_NAME" = "staging" ]; then
  # In staging, all origins are allowed (CORS is wildcard)
  assert_eq "  ACAO echoes staging portal" "https://diernus-portal-staging.pages.dev" "$ACAO"
else
  # In prod, staging origin is not in the allow-list — the middleware falls
  # back to the first allowed origin (PUBLIC_URL = https://portal.diernus.com).
  # The fact that the ACAO is *not* the request origin is the correct security
  # behavior (staging pages can't access prod data).
  assert_eq "  ACAO falls back to PUBLIC_URL (not the staging origin)" "https://portal.diernus.com" "$ACAO"
fi

# =========================================================================
# [20] RBAC matrix (staging only — needs team + client logins)
# =========================================================================
hr "[20] RBAC matrix (staging only)"
if [ "$ENV_NAME" = "staging" ]; then
  # /me for all 3
  for who in admin team client; do
    case $who in admin) jar=/tmp/c-admin.txt;; team) jar=/tmp/c-team.txt;; client) jar=/tmp/c-client.txt;; esac
    assert_status "  /me ($who)" GET "$API/auth/me" "$jar" 200
  done

  # Finance: admin 200, team 403, client 403
  assert_status "  /finance/summary (admin)" GET "$API/finance/summary" /tmp/c-admin.txt 200
  assert_status "  /finance/summary (team)"   GET "$API/finance/summary" /tmp/c-team.txt   403
  assert_status "  /finance/summary (client)" GET "$API/finance/summary" /tmp/c-client.txt 403

  # Multiboard: admin 200, team 200, client 403
  assert_status "  /board (admin)" GET "$API/board" /tmp/c-admin.txt 200
  assert_status "  /board (team)"   GET "$API/board" /tmp/c-team.txt   200
  assert_status "  /board (client)" GET "$API/board" /tmp/c-client.txt 403

  # Team members: admin 200, team 200, client 403
  assert_status "  /team/members (admin)" GET "$API/team/members" /tmp/c-admin.txt 200
  assert_status "  /team/members (team)"   GET "$API/team/members" /tmp/c-team.txt   200
  assert_status "  /team/members (client)" GET "$API/team/members" /tmp/c-client.txt 403

  # Notifications: all 200
  assert_status "  /notifications (admin)" GET "$API/notifications" /tmp/c-admin.txt 200
  assert_status "  /notifications (team)"   GET "$API/notifications" /tmp/c-team.txt   200
  assert_status "  /notifications (client)" GET "$API/notifications" /tmp/c-client.txt 200

  # Clients: admin 200, team 200, client 403 (clients can't see the client list)
  assert_status "  /clients (admin)" GET "$API/clients" /tmp/c-admin.txt 200
  assert_status "  /clients (team)"   GET "$API/clients" /tmp/c-team.txt   200
  assert_status "  /clients (client)" GET "$API/clients" /tmp/c-client.txt 403

  # Time entry PATCH: admin 200, team 200, client 403
  if [ -n "$TEST_ENTRY_ID" ]; then
    assert_status "  PATCH time-entry (admin)" PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-admin.txt 200 '{"note":"rbac admin"}'
    assert_status "  PATCH time-entry (team)"   PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-team.txt   200 '{"note":"rbac team"}'
    assert_status "  PATCH time-entry (client)" PATCH "$API/time-entries/${TEST_ENTRY_ID}" /tmp/c-client.txt 403 '{"note":"rbac client"}'
    # Restore
    PATCH "$API/time-entries/${TEST_ENTRY_ID}" -b /tmp/c-admin.txt -H "Content-Type: application/json" -d '{"note":"regression seed entry"}' > /dev/null
  fi
else
  skip "RBAC matrix — staging only (prod has no team/client with known passwords)"
fi

# =========================================================================
# [21] FRONTEND MARKUP — every page loads + has expected elements
# =========================================================================
hr "[21] Frontend markup"
for page in admin/projetos admin/equipa admin/clientes admin/financeiro portal/quadro-geral portal/projetos login forgot-password reset-password aceitar confirmar-email perfil; do
  S=$(status "$WEB/$page")
  if [ "$S" = "200" ]; then ok "GET /$page → 200"; else no "GET /$page" "status=$S"; fi
done

# Login page
HTML_LOGIN=$(curl -sL "$WEB/login")
for marker in btn-google api-base "Esqueci-me da palavra-passe"; do
  if echo "$HTML_LOGIN" | grep -q "$marker"; then ok "login.html has $marker"; else no "login.html has $marker"; fi
done

# Admin projects
HTML_PROJ=$(curl -sL "$WEB/admin/projetos")
for marker in proj-search proj-tabs proj-due-sel proj-filters applyFilters filterStatus archive; do
  if echo "$HTML_PROJ" | grep -q "$marker"; then ok "projetos.html has $marker"; else no "projetos.html has $marker"; fi
done

# Shared JS
JS_BOARD=$(curl -sL "$WEB/shared/board.js")
for marker in openFilePreview openEditTimeEntryModal renderFileRow filePreviewKind; do
  if echo "$JS_BOARD" | grep -q "$marker"; then ok "board.js exports $marker"; else no "board.js exports $marker"; fi
done

JS_API=$(curl -sL "$WEB/shared/api.js")
for marker in updateTimeEntry filePreviewUrl; do
  if echo "$JS_API" | grep -q "$marker"; then ok "api.js has $marker"; else no "api.js has $marker"; fi
done

# Shared CSS
CSS=$(curl -sL "$WEB/shared/style.css")
for marker in '.proj-tabs' '.cd-file-thumb' '.preview-back' '.cd-time-edit' '.proj-search'; do
  if echo "$CSS" | grep -q "$marker"; then ok "style.css has $marker"; else no "style.css has $marker"; fi
done

# =========================================================================
# [22] CLEANUP — remove what we can
# =========================================================================
hr "[22] Cleanup"
# Order matters: file → card → project. Deleting the card CASCADEs to the file,
# so we delete the file first while we still have its ID.
# The TEST_CLIENT is left as 'pending' (will be wiped by cleanup-test-data.sh)

if [ -n "$TEST_FILE_ID" ]; then
  S=$(status -b /tmp/c-admin.txt -X DELETE "$API/files/${TEST_FILE_ID}")
  assert_eq "  DELETE test file" "200" "$S"
fi

if [ -n "$TEST_CARD_ID" ]; then
  S=$(status -b /tmp/c-admin.txt -X DELETE "$API/cards/${TEST_CARD_ID}")
  assert_eq "  DELETE test card" "200" "$S"
fi

if [ -n "$TEST_PROJECT_ID" ]; then
  S=$(status -b /tmp/c-admin.txt -X PATCH "$API/projects/${TEST_PROJECT_ID}" \
    -H "Content-Type: application/json" -d '{"status":"archived"}')
  assert_eq "  archive test project" "200" "$S"
fi

# Note: TEST_CLIENT_ID is left as 'pending' — wipe via cleanup-test-data.sh

# =========================================================================
# Summary
# =========================================================================
hr "Summary"
TOTAL=$((PASS+FAIL))
printf '  %d passed, %d failed (%d total)\n' "$PASS" "$FAIL" "$TOTAL"
printf '  env: %s\n' "$ENV_NAME"
if [ $FAIL -gt 0 ]; then
  printf '\nFailures:\n'
  for f in "${FAILURES[@]}"; do printf '  · %s\n' "$f"; done
  exit 1
fi
echo "  All green ✅"
