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
# Cloud device: created behind Access, token returned once, works for ingest
CR=$(curl -s -XPOST $B/api/admin/cloud-device -d '{"name":"cloud"}')
CT=$(echo "$CR" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')
check "cloud device gets a token"  "${#CT}" 64
check "cloud token ingests"        "$(code_of -XPOST $B/api/ingest -H "x-device-token: $CT" -d "[{\"turn_id\":\"cc:s:1\",\"session_id\":\"s\",\"ts\":\"$YDAY\",\"model\":\"m\",\"output_tokens\":3}]")" 204
check "cloud device needs a name"  "$(code_of -XPOST $B/api/admin/cloud-device -d '{}')" 400
# A later, fuller report of the same turn completes it (the log can lag a moment)
code_of -XPOST $B/api/ingest -H "x-device-token: $CT" -d "[{\"turn_id\":\"cc:s:1\",\"session_id\":\"s\",\"ts\":\"$YDAY\",\"model\":\"m\",\"output_tokens\":50}]" >/dev/null
code_of -XPOST $B/api/ingest -H "x-device-token: $CT" -d "[{\"turn_id\":\"cc:s:1\",\"session_id\":\"s\",\"ts\":\"$YDAY\",\"model\":\"m\",\"output_tokens\":7}]" >/dev/null
curl -s "$B/api/admin/stats?days=30" | python3 -c "import sys,json; d=json.load(sys.stdin); c=[x for x in d['byDevice'] if x['device']=='cloud'][0]; sys.exit(0 if (c['output'],c['turns'])==(50,1) else 1)" && echo "ok   later report completes a turn, never shrinks it" || { echo "FAIL turn merge"; fail=1; }
# Plan limits arrive with the turns ({rows, limits}); an unchanged reading is not stored twice
LIM='{"rows":[],"limits":[{"kind":"seven_day","percentUsed":12.5,"resetsAt":"2099-01-01T00:00:00Z"},{"kind":"five_hour","percentUsed":3,"resetsAt":"2099-01-01T05:00:00Z"}]}'
check "limits-only ingest"         "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$LIM")" 204
check "same limits again"          "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$LIM")" 204
check "empty ingest is rejected"   "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d '{"rows":[]}')" 400
check "limits stored once"         "$(curl -s "$B/api/admin/limits" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')" 2
code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d '{"limits":[{"kind":"seven_day","percentUsed":14,"resetsAt":"2099-01-01T00:00:00Z"}]}' >/dev/null
check "changed limit is added"     "$(curl -s "$B/api/admin/limits" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')" 3
check "bad limit kind ignored"     "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d '{"limits":[{"kind":"x; drop","percentUsed":1}]}')" 204
check "buckets: hourly sums"       "$(curl -s "$B/api/admin/buckets" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(int(len(d)>0 and all(len(r["h"])==13 and r["device"] for r in d)))')" 1
check "turns: raw rows"            "$(curl -s "$B/api/admin/turns" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(int(len(d)>0 and "session_id" in d[0]))')" 1
check "sessions: per session"      "$(curl -s "$B/api/admin/sessions" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(int(len(d)>0 and "first_ts" in d[0] and d[0]["model"]!=None))')" 1
CX='[{"session_id":"cx1","turn_id":"codex:th1:1","provider":"codex","ts":"2026-10-22T11:00:00Z","model":"gpt-5","input_tokens":50,"output_tokens":8,"cache_read_tokens":20}]'
check "codex turn accepted"         "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$CX")" 204
check "unknown provider rejected"   "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d '[{"turn_id":"z","provider":"nope","ts":"2026-10-22T11:00:00Z"}]')" 400
check "provider in buckets"         "$(curl -s "$B/api/admin/buckets" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sorted({r["provider"] for r in d}))')" "['claude', 'codex']"
check "provider in sessions"        "$(curl -s "$B/api/admin/sessions" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sorted({r["provider"] for r in d}))')" "['claude', 'codex']"
code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d '{"limits":[{"provider":"codex","kind":"seven_day","percentUsed":14,"resetsAt":"2099-01-01T00:00:00Z"}]}' >/dev/null
check "limits kept per provider"    "$(curl -s "$B/api/admin/limits" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sorted({r["provider"] for r in d}))')" "['claude', 'codex']"
check "device lists its providers"  "$(curl -s "$B/api/admin/devices" | ID=$ID python3 -c 'import sys,json,os; d=[x for x in json.load(sys.stdin) if x["id"]==os.environ["ID"]]; print(sorted(d[0]["providers"]))')" "['claude', 'codex']"
check "range can be narrowed"      "$(curl -s "$B/api/admin/buckets?from=2001-01-01T00:00:00Z&to=2001-01-02T00:00:00Z")" "[]"
check "revoke device"            "$(code_of -XDELETE $B/api/admin/devices/$ID)" 204
check "revoked token rejected"   "$(code_of -XPOST $B/api/ingest -H "x-device-token: $TOKEN" -d "$ROW")" 401
exit $fail
