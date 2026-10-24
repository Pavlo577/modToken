#!/usr/bin/env bash
# End-to-end check of the OTLP receiver (POST /v1/logs) against `wrangler dev` (DEV_EMAIL set, fresh local D1: bun run db:local).
set -u
B=http://127.0.0.1:8787
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
T=$(mktemp -d)

CODE=$(curl -s -XPOST $B/api/admin/codes -d '{"name":"otlp-box"}' | sed -E 's/.*"code":"([A-F0-9]+)".*/\1/')
TOKEN=$(curl -s -XPOST $B/api/link -d "{\"code\":\"$CODE\"}" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')

# one OTLP/JSON logs payload: api_request calls (request id, prompt id, input, output, cache read, duration) + noise that must not be kept
payload() { python3 - "$@" <<'PY'
import json, sys, time
calls = [a.split(',') for a in sys.argv[1:]]
now = time.time_ns()
def kv(k, v): return {"key": k, "value": ({"intValue": str(v)} if isinstance(v, int) else {"stringValue": v})}
recs = []
for i, (req, prompt, inp, out, cr, dur) in enumerate(calls):
    recs.append({"timeUnixNano": str(now + i * 1_000_000), "attributes": [kv("event.name", "claude_code.api_request"), kv("session.id", "sess-otlp"), kv("prompt.id", prompt), kv("request_id", req),
        kv("model", "claude-sonnet-x"), kv("input_tokens", int(inp)), kv("output_tokens", int(out)), kv("cache_read_tokens", int(cr)), kv("cache_creation_tokens", 0), kv("duration_ms", int(dur)),
        kv("user.email", "secret.person@example.com"), kv("organization.id", "org-secret")]})
recs.append({"timeUnixNano": str(now), "attributes": [kv("event.name", "claude_code.user_prompt"), kv("session.id", "sess-otlp"), kv("prompt", "TOP SECRET PROMPT")]})
print(json.dumps({"resourceLogs": [{"resource": {"attributes": [kv("service.name", "claude-code")]}, "scopeLogs": [{"logRecords": recs}]}]}))
PY
}
post() { curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/logs -H "x-device-token: $TOKEN" -H 'content-type: application/json' --data-binary "$1"; }
sums() { curl -s "$B/api/admin/buckets" | python3 -c 'import sys,json; d=[r for r in json.load(sys.stdin) if r["provider"]=="claude" and r["device"]=="otlp-box"]; print(sum(r["output"] for r in d), sum(r["input"] for r in d), sum(r["cache_read"] for r in d), sum(r["turns"] for r in d), sum(r["duration_ms"] for r in d))'; }

P1=$(payload req_a,P1,100,10,1000,1000 req_b,P1,20,5,2000,500 req_c,P2,7,3,0,100)
check "logs accepted (200)" "$(post "$P1")" 200
check "two prompts = two turns; the calls of a prompt are added up" "$(sums)" "18 127 3000 2 1600"
check "the same payload again changes nothing" "$(post "$P1" >/dev/null; sums)" "18 127 3000 2 1600"

# gzip body (exporters may compress), a call that joins an existing turn
GZ=$(payload req_d,P2,1,4,50,200 | gzip -c)
printf '%s' "$GZ" > /dev/null
payload req_d,P2,1,4,50,200 | gzip -c > $T/body.gz
code=$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/logs -H "x-device-token: $TOKEN" -H 'content-type: application/json' -H 'content-encoding: gzip' --data-binary @$T/body.gz)
check "gzip accepted" "$code" 200
check "the call joined its turn (no new turn)" "$(sums)" "22 128 3050 2 1800"

# Authorization: Bearer works as the header (how most exporters are configured)
code=$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/logs -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary "$(payload req_e,P3,2,6,0,50)")
check "Bearer accepted" "$code" 200
check "a new prompt is a new turn" "$(sums)" "28 130 3050 3 1850"

# errors an exporter must get right
check "wrong token: 401" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/logs -H 'x-device-token: nope' -H 'content-type: application/json' --data-binary "$P1")" 401
check "no token: 401" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/logs -H 'content-type: application/json' --data-binary "$P1")" 401
check "protobuf: 415 (use http/json)" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/logs -H "x-device-token: $TOKEN" -H 'content-type: application/x-protobuf' --data-binary 'x')" 415
check "not JSON: 400" "$(post '{ broken')" 400
check "JSON that is not OTLP: 400" "$(post '{"hello":1}')" 400
check "metrics are accepted and dropped" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/metrics -H "x-device-token: $TOKEN" -H 'content-type: application/json' --data-binary '{"resourceMetrics":[]}')" 200
check "metrics without a token: 401" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/metrics -H 'content-type: application/json' --data-binary '{}')" 401
check "an empty request is fine" "$(post '{"resourceLogs":[]}')" 200

# a revoked device is refused
DEV=$(curl -s $B/api/admin/devices | python3 -c 'import sys,json; print([d["id"] for d in json.load(sys.stdin) if d["name"]=="otlp-box"][0])')
check "the device saw data (last_seen)" "$(curl -s $B/api/admin/devices | python3 -c 'import sys,json; print([bool(d["last_seen"]) for d in json.load(sys.stdin) if d["name"]=="otlp-box"][0])')" True
# nothing personal or textual was kept anywhere the dashboard can read
ALL="$(curl -s $B/api/admin/turns; curl -s $B/api/admin/sessions; curl -s $B/api/admin/buckets; curl -s $B/api/admin/devices)"
check "no email, organisation or prompt text in anything stored" "$(printf '%s' "$ALL" | grep -c 'secret.person\|org-secret\|TOP SECRET')" 0
curl -s -o /dev/null -XDELETE $B/api/admin/devices/$DEV
check "a revoked device: 401" "$(post "$P1")" 401
rm -rf "$T"
exit $fail
