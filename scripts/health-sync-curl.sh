#!/usr/bin/env bash
# Exercises every Apple Health shortcut route with curl, the way the iPhone
# shortcuts call them, so the server can be tested before any iPhone is involved.
#
#   BASE=https://food.example.com SHORTCUT_KEY=YOUR_KEY scripts/health-sync-curl.sh
#   scripts/health-sync-curl.sh http://127.0.0.1:8080 YOUR_KEY       # same thing
#
# It is safe to run against a real server: it only READS (status, pending, a
# rejected ack, a rejected revoke) unless you pass --write, which also acks what
# pending offers and sends one activity day. Acking marks values as "already in
# Apple Health", so use --write only on a test server or with a throw-away
# profile. With --write and MCP_KEY set, it first logs one synthetic meal over MCP
# (so there is something to sync). Requires curl and jq. The shortcut key is sent
# only as an Authorization header.
set -euo pipefail

WRITE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--write" ]; then WRITE=1; else ARGS+=("$a"); fi
done
BASE="${ARGS[0]:-${BASE:-}}"
KEY="${ARGS[1]:-${SHORTCUT_KEY:-}}"
[ -n "$BASE" ] && [ -n "$KEY" ] || { echo "usage: BASE=... SHORTCUT_KEY=... $0 [--write]" >&2; exit 2; }
BASE="${BASE%/}"
API="$BASE/api/v1/health-sync"
H=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
# curl returning "<status> <body>"; the key never appears in the output.
req() { curl -sS -o /tmp/hs.$$ -w '%{http_code}' "$@"; echo " $(cat /tmp/hs.$$)"; rm -f /tmp/hs.$$; }

step "no key -> 401"
out=$(req "$API/pending"); echo "$out"; [[ "$out" == 401* ]] || fail "expected 401 without a key"

step "wrong key -> 401 (same answer)"
out=$(req -H "Authorization: Bearer not-the-key" "$API/pending"); echo "$out"; [[ "$out" == 401* ]] || fail "expected 401 for a wrong key"

step "key in the URL is NOT accepted"
out=$(req "$API/pending?key=$KEY"); [[ "$out" == 401* ]] || fail "a key in the URL must not authenticate"; echo "${out%% *} (as required)"

step "GET status"
curl -sS "${H[@]}" "$API/status" | jq '{ok, timezone, last_sync_at, last_ack_at, last_activity_at, pending_entries, discrepancies: (.discrepancies|length), window}'

if [ "$WRITE" = 1 ] && [ -n "${MCP_KEY:-}" ]; then
  step "log one synthetic meal over MCP so there is something to sync (--write)"
  curl -sS -X POST "$BASE/mcp/$MCP_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_meal","arguments":{"description":"synthetic test meal","meal_type":"snack","calories":333,"protein_g":12.5}}}' \
    | sed -n 's/^data: //p;/^{/p' | jq -r '.result.content[0].text' | head -3
fi

step "GET pending (water included)"
P=$(curl -sS "${H[@]}" "$API/pending?water=1")
echo "$P" | jq '{ok, now, timezone, count, lease_until, entries, discrepancies, notices}'
[ "$(echo "$P" | jq -r .ok)" = "true" ] || fail "pending not ok"

step "POST ack with a malformed body -> 400"
out=$(req -X POST "${H[@]}" -d '{"entries":[{"entry_id":"nope"}]}' "$API/ack"); echo "$out"; [[ "$out" == 400* ]] || fail "expected 400"

step "POST revoke without confirm -> 400 (nothing forgotten)"
out=$(req -X POST "${H[@]}" -d '{}' "$API/revoke"); echo "$out"; [[ "$out" == 400* ]] || fail "expected 400"

if [ "$WRITE" = 1 ]; then
  step "POST ack of exactly what pending offered (--write)"
  ACK=$(echo "$P" | jq -c '{entries: [.entries[] | {entry_id, date, values}], done: true, lease_until: .lease_until}')
  curl -sS -X POST "${H[@]}" -d "$ACK" "$API/ack" | jq .
  step "POST the same ack again -> everything skipped (idempotent)"
  curl -sS -X POST "${H[@]}" -d "$ACK" "$API/ack" | jq '{applied, skipped}'
  step "GET pending again -> nothing left to offer"
  curl -sS "${H[@]}" "$API/pending?water=1" | jq '{count, entries}'
  step "POST activity: one day, replaced (never added) on each run"
  TODAY=$(echo "$P" | jq -r .window.to)
  curl -sS -X POST "${H[@]}" -d "{\"days\":[{\"date\":\"$TODAY\",\"active_kcal\":321}]}" "$API/activity" | jq '{ok, written, changed, skipped, status}'
  curl -sS -X POST "${H[@]}" -d "{\"days\":[{\"date\":\"$TODAY\",\"active_kcal\":321}]}" "$API/activity" | jq '{changed}'
else
  echo; echo "(read-only run; pass --write to also ack what pending offers and send one activity day)"
  # Free the lease taken by pending, if it took one.
  L=$(echo "$P" | jq -r '.lease_until // empty')
  [ -z "$L" ] || curl -sS -X POST "${H[@]}" -d "{\"done\":true,\"lease_until\":\"$L\"}" "$API/ack" >/dev/null
fi
echo; echo "ALL ROUTES OK"
