#!/usr/bin/env bash
# End-to-end check against `wrangler dev` (local D1, DEV_EMAIL=me@example.com in .dev.vars).
set -u
B=http://127.0.0.1:8787
if [ "${1:-}" = "--gate" ]; then
  # Run against `wrangler dev` started WITHOUT DEV_EMAIL (production-like): the Access gate must hold.
  c() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
  [ "$(c $B/api/admin/me)" = 401 ] && echo "ok   admin needs Access" || { echo "FAIL admin open"; exit 1; }
  [ "$(c $B/api/admin/me -H 'cf-access-authenticated-user-email: evil@x.com')" = 401 ] && echo "ok   forged email header ignored" || { echo "FAIL forged header accepted"; exit 1; }
  [ "$(c $B/api/admin/me -H 'cf-access-jwt-assertion: a.b.c')" = 401 ] && echo "ok   forged JWT rejected" || { echo "FAIL forged JWT accepted"; exit 1; }
  exit 0
fi
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

CODE=$(curl -s -XPOST $B/api/admin/codes -d '{"name":"test-box"}' | sed -E 's/.*"code":"([A-F0-9]+)".*/\1/')
check "admin creates a code" "${#CODE}" 10
check "bad code rejected"        "$(code_of -XPOST $B/api/link -d '{"code":"ZZZZZZZZZZ"}')" 403
RES=$(curl -s -XPOST $B/api/link -d "{\"code\":\"$CODE\"}")
TOKEN=$(echo "$RES" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')
check "code links a device"      "${#TOKEN}" 64
check "code works only once"     "$(code_of -XPOST $B/api/link -d "{\"code\":\"$CODE\"}")" 403
check "ingest without token"     "$(code_of -XPOST $B/api/ingest -d '[]')" 401
ROW='[{"session_id":"s1","turn_id":"t1","ts":"2026-10-22T10:00:00Z","model":"m","input_tokens":5,"output_tokens":7,"cache_read_tokens":1,"cache_creation_tokens":2,"duration_ms":900,"is_subagent":false}]'
check "ingest with token"        "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$ROW")" 204
check "duplicate turn ignored"   "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$ROW")" 204
check "bad timestamp rejected"   "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d '[{"ts":"nope"}]')" 400
STATS=$(curl -s "$B/api/admin/stats?days=365")
echo "$STATS" | grep -q '"turns":1' && echo "ok   one turn counted" || { echo "FAIL stats: $STATS"; fail=1; }
ID=$(curl -s $B/api/admin/devices | sed -E 's/.*"id":"([0-9a-f-]{36})".*/\1/')
imp() { curl -s -XPOST $B/api/admin/import -d "{\"device_id\":\"$ID\",\"rows\":[$1]}"; }
YDAY=$(date -u -d "1 day ago" +%Y-%m-%dT%H:%M:%SZ)
OLD="{\"turn_id\":\"imp:f:1\",\"session_id\":\"s0\",\"ts\":\"$YDAY\",\"model\":\"m\",\"input_tokens\":1,\"output_tokens\":2,\"cache_read_tokens\":3,\"cache_creation_tokens\":4,\"duration_ms\":5}"
check "import adds history"      "$(imp "$OLD" | grep -c '"inserted":1')" 1
check "re-import adds nothing"   "$(imp "$OLD" | grep -c '"inserted":0,"duplicates":1')" 1
NEW='{"turn_id":"imp:f:2","session_id":"s0","ts":"2099-01-01T10:00:00Z","model":"m","output_tokens":9}'
check "after-link rows skipped"  "$(imp "$NEW" | grep -c '"afterLink":1')" 1
check "import needs imp: ids"    "$(code_of -XPOST $B/api/admin/import -d "{\"device_id\":\"$ID\",\"rows\":[{\"turn_id\":\"x\",\"ts\":\"2020-01-01T00:00:00Z\"}]}")" 400
check "import: unknown device"   "$(code_of -XPOST $B/api/admin/import -d '{"device_id":"00000000-0000-0000-0000-000000000000","rows":[{}]}')" 404
curl -s "$B/api/admin/stats?days=30" | grep -q '"turns":2' && echo "ok   imported turn counted" || { echo "FAIL imported turn missing"; fail=1; }
# Device-token import (what /tracker-import uses)
dimp() { curl -s -XPOST $B/api/import -H "x-device-token: $1" -d "{\"rows\":[$2]}"; }
OLD2="{\"turn_id\":\"imp:g:1\",\"session_id\":\"s0\",\"ts\":\"$YDAY\",\"model\":\"m\",\"output_tokens\":4}"
check "token import: no token"     "$(code_of -XPOST $B/api/import -d '{"rows":[{}]}')" 401
check "token import adds history"  "$(dimp "$TOKEN" "$OLD2" | grep -c '"inserted":1')" 1
check "token import is idempotent" "$(dimp "$TOKEN" "$OLD2" | grep -c '"inserted":0,"duplicates":1')" 1
check "revoke device"            "$(code_of -XDELETE $B/api/admin/devices/$ID)" 204
check "revoked token rejected"   "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$ROW")" 401
exit $fail
