#!/usr/bin/env bash
# End-to-end check of the whole flow (add a device, OTLP in, dashboard API out, revoke) against `wrangler dev` (DEV_EMAIL set, fresh local D1: bun run db:local).
set -u
B=http://127.0.0.1:8787
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
T=$(mktemp -d)

TOKEN=$(curl -s -XPOST $B/api/admin/devices -d '{"name":"otlp-box"}' | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')
check "a device gets a 64-character token" "${#TOKEN}" 64
check "a device needs a name" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/api/admin/devices -d '{"name":" "}')" 400

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

# the events database: the harmless attributes of every event are kept, nothing about the user or the conversation
post "$(python3 - <<'PY'
import json, time
now = time.time_ns()
def kv(k, v): return {"key": k, "value": ({"intValue": str(v)} if isinstance(v, int) else {"stringValue": v})}
recs = [{"timeUnixNano": str(now + i), "attributes": [kv("event.name", "claude_code.tool_result"), kv("session.id", "sess-ev"), kv("prompt.id", "pe"), kv("terminal.type", "pycharm"), kv("event.sequence", i),
  kv("tool_name", "Bash"), kv("success", "true"), kv("duration_ms", "250"), kv("user.email", "secret.person@example.com"), kv("organization.id", "org-secret"), kv("process.owner", "secretuser"),
  kv("brand_new_field", 7), kv("prompt", "TOP SECRET PROMPT"), kv("summary", "a secret sentence with spaces"), kv("contact", "secret.person@example.com")]} for i in range(3)]
print(json.dumps({"resourceLogs": [{"resource": {"attributes": [kv("service.name", "claude-code")]}, "scopeLogs": [{"logRecords": recs}]}]}))
PY
)" > /dev/null
post "$(cat <<'JSON'
{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1761300000000000000","attributes":[{"key":"event.name","value":{"stringValue":"claude_code.tool_result"}},{"key":"session.id","value":{"stringValue":"sess-ev"}},{"key":"event.sequence","value":{"intValue":"0"}},{"key":"tool_name","value":{"stringValue":"Bash"}}]}]}]}]}
JSON
)" > /dev/null
EV() { npx wrangler d1 execute modtoken-events --local --json --command "$1" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["results"][0]["n"])'; }
check "tool events were stored" "$(EV "SELECT COUNT(*) AS n FROM events WHERE name = 'tool_result' AND session_id = 'sess-ev'")" 3
check "no email, identity, text or prose in any stored attribute" "$(EV "SELECT COUNT(*) AS n FROM events WHERE attrs LIKE '%secret%' OR attrs LIKE '%SECRET%' OR attrs LIKE '%@%' OR attrs LIKE '%org-%'")" 0
post "$(cat <<'JSON'
{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1761300001000000000","attributes":[{"key":"event.name","value":{"stringValue":"claude_code.api_request"}},{"key":"session.id","value":{"stringValue":"sess-cost"}},{"key":"prompt.id","value":{"stringValue":"pc"}},{"key":"request_id","value":{"stringValue":"req_cost_1"}},{"key":"model","value":{"stringValue":"claude-sonnet-5-5"}},{"key":"input_tokens","value":{"intValue":"5"}},{"key":"output_tokens","value":{"intValue":"7"}},{"key":"cost_usd_micros","value":{"intValue":"1234"}}]}]}]}]}
JSON
)" > /dev/null
check "the cost the agent states is stored with the turn (micros)" "$(npx wrangler d1 execute modtoken --local --json --command "SELECT cost_micros AS n FROM token_events WHERE session_id = 'sess-cost'" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["results"][0]["n"])')" 1234
post "$(python3 - <<'PY'
import json, time
now = time.time_ns()
def kv(k, v): return {"key": k, "value": {"stringValue": str(v)}}
recs = [
  {"timeUnixNano": str(now), "attributes": [kv("event.name", "claude_code.compaction"), kv("session.id", "sess-c"), kv("trigger", "auto"), kv("success", "true"), kv("pre_tokens", 150000), kv("post_tokens", 20000), kv("duration_ms", 9000)]},
  {"timeUnixNano": str(now + 1), "attributes": [kv("event.name", "claude_code.subagent_completed"), kv("session.id", "sess-c"), kv("agent_type", "Explore"), kv("total_tool_uses", 12), kv("duration_ms", 30000)]},
]
print(json.dumps({"resourceLogs": [{"resource": {"attributes": [kv("service.name", "claude-code")]}, "scopeLogs": [{"logRecords": recs}]}]}))
PY
)" > /dev/null
check "compaction and sub-agent events reach their cards" "$(curl -s $B/api/admin/insights | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["compaction"][0]["saved"], d["subagents"][0]["agent"], d["subagents"][0]["runs"])')" "130000 Explore 1"
check "a field that is not in the registry is reported as new" "$(curl -s $B/api/admin/insights | python3 -c 'import sys,json; print([x["key"] for x in json.load(sys.stdin)["unknownFields"]])')" "['brand_new_field']"
check "response-time statistics and their distribution are computed" "$(curl -s $B/api/admin/insights | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["latencyStats"]["duration"]["n"] > 0, sum(b["n"] for b in d["latencyHist"]["duration"]) == d["latencyStats"]["duration"]["n"], len(d["latencyDaily"]) > 0)')" "True True True"
check "the insights API answers" "$(curl -s $B/api/admin/insights | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["available"], d["tools"][0]["tool"], d["tools"][0]["runs"])')" "True Bash 3"

# a revoked device is refused
DEV=$(curl -s $B/api/admin/devices | python3 -c 'import sys,json; print([d["id"] for d in json.load(sys.stdin) if d["name"]=="otlp-box"][0])')
check "the device saw data (last_seen)" "$(curl -s $B/api/admin/devices | python3 -c 'import sys,json; print([bool(d["last_seen"]) for d in json.load(sys.stdin) if d["name"]=="otlp-box"][0])')" True
# nothing personal or textual was kept anywhere the dashboard can read
ALL="$(curl -s $B/api/admin/turns; curl -s $B/api/admin/sessions; curl -s $B/api/admin/buckets; curl -s $B/api/admin/devices)"
check "no email, organisation or prompt text in anything stored" "$(printf '%s' "$ALL" | grep -c 'secret.person\|org-secret\|TOP SECRET')" 0

# history from local logs: only numbers arrive, a resent import adds nothing, data the device already sends through OTLP is not counted twice
HB=$(curl -s -XPOST $B/api/admin/devices -d '{"name":"hist-box"}' >/dev/null; curl -s $B/api/admin/devices | python3 -c 'import sys,json; print([d["id"] for d in json.load(sys.stdin) if d["name"]=="hist-box"][0])')
imp() { curl -s -XPOST $B/api/admin/import -d "{\"device_id\":\"$1\",\"turns\":$2}"; }
TURNS='[{"id":"msg_a","session":"s1","ts":"2026-01-05T10:00:00.000Z","model":"claude-sonnet-x","input":2,"output":100,"cache_read":1000,"cache_creation":10,"sub":false},{"id":"msg_b","session":"s1","ts":"2026-01-05T10:01:00.000Z","model":"claude-sonnet-x","input":4,"output":50,"cache_read":2000,"cache_creation":0,"sub":true}]'
check "an import adds the new turns" "$(imp $HB "$TURNS" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["added"], d["received"])')" "2 2"
check "importing the same turns again adds nothing" "$(imp $HB "$TURNS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["added"])')" 0
check "the imported numbers are in the dashboard" "$(curl -s "$B/api/admin/buckets?from=2026-01-01&to=2026-12-31" | python3 -c 'import sys,json; d=[r for r in json.load(sys.stdin) if r["device"]=="hist-box"]; print(sum(r["output"] for r in d), sum(r["turns"] for r in d))')" "150 2"
check "an import for a device that is not yours: 404" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/api/admin/import -d '{"device_id":"00000000-0000-0000-0000-000000000000","turns":[]}')" 404
check "a turn from when the device already reports through OTLP is skipped" "$(imp $DEV '[{"id":"msg_c","session":"s1","ts":"2999-01-01T00:00:00.000Z","model":"m","input":1,"output":1,"cache_read":0,"cache_creation":0,"sub":false}]' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["added"], d["invalid"])')" "0 1"
check "the moment OTLP started counting is recorded per device" "$(curl -s $B/api/admin/devices | python3 -c 'import sys,json; d={x["name"]:x["otlp_since"] for x in json.load(sys.stdin)}; print(bool(d["otlp-box"]), d["hist-box"])')" "True None"
check "the oldest turn bounds the calendars" "$(curl -s $B/api/admin/bounds | python3 -c 'import sys,json; print(json.load(sys.stdin)["first"] <= "2026-01-05T10:00:00.000Z")')" True
check "importing turns from before OTLP started still works, later ones are skipped" "$(imp $DEV '[{"id":"msg_old","session":"s9","ts":"2025-01-01T00:00:00.000Z","model":"m","input":1,"output":1,"cache_read":0,"cache_creation":0,"sub":false}]' | python3 -c 'import sys,json; print(json.load(sys.stdin)["added"])')" 1
lim() { curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/limits -H "x-device-token: $1" -H 'content-type: application/json' --data-binary "$2"; }
L1='{"limits":[{"kind":"five_hour","percentUsed":38,"resetsAt":"2026-10-26T01:40:00.000Z"},{"kind":"seven_day","percentUsed":11}],"cwd":"/home/SECRETUSER"}'
check "limits: a device token is needed" "$(lim wrong "$L1")" 401
check "limits: a body without a list is refused" "$(lim $TOKEN '{"rows":[]}')" 400
check "limits: readings are accepted" "$(lim $TOKEN "$L1")" 200
lim $TOKEN "$L1" >/dev/null
lim $TOKEN '{"limits":[{"kind":"five_hour","percentUsed":39,"resetsAt":"2026-10-26T01:40:00.000Z"}]}' >/dev/null
check "limits: an unchanged reading is stored once, a change is stored" "$(curl -s "$B/api/admin/limits?from=$(date -u -d "-1 day" +%F)&to=$(date -u -d "+1 day" +%F)" | python3 -c 'import sys,json; d=[r for r in json.load(sys.stdin) if r["device"]=="otlp-box"]; print(len(d), sorted(r["percent"] for r in d if r["kind"]=="five_hour"))')" "3 [38, 39]"
check "limits: nothing else of the body is kept" "$(curl -s "$B/api/admin/limits?from=$(date -u -d "-1 day" +%F)&to=$(date -u -d "+1 day" +%F)" | grep -c SECRET)" 0
# the mod's sessions and turns (POST /v1/activity) and what the device lets it send (GET /v1/config, PATCH project_mode)
act() { curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/activity -H "x-device-token: $TOKEN" -H 'content-type: application/json' --data-binary "$1"; }
NOW=$(date -u +%FT%T.000Z)
TURN() { echo "{\"id\":\"$1\",\"session\":\"sess-otlp\",\"ts\":\"$NOW\",\"wall_ms\":$2,\"think_ms\":3000,\"outcome\":\"answer\",\"context_pct\":$3,\"perm_asks\":1,\"perm_denied\":0,\"perm_wait_ms\":5000,\"prompt\":\"SECRET PROMPT\"}"; }
check "config: the project is off by default" "$(curl -s $B/v1/config -H "x-device-token: $TOKEN")" '{"project":"off"}'
check "activity: a device token is needed" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/v1/activity -H 'x-device-token: wrong' --data-binary '{}')" 401
check "activity: a session and turns are accepted" "$(act "{\"session\":{\"id\":\"sess-otlp\",\"started_at\":\"$NOW\",\"project\":\"owner/secret-repo\"},\"turns\":[$(TURN t1 10000 40),$(TURN t2 20000 95)]}")" 200
act "{\"turns\":[$(TURN t1 10000 40)]}" >/dev/null
MS() { curl -s "$B/api/admin/mod-stats?from=$(date -u -d '-1 day' +%F)&to=$(date -u -d '+1 day' +%F)"; }
check "activity: a turn sent twice counts once; context and time are summed up" "$(MS | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["time"]["wall"]["n"], d["context"]["over90"], d["permissions"]["asks"], d["sessions"]["count"])')" "2 1 2 1"
check "activity: with the project off, no project is stored" "$(MS | python3 -c 'import sys,json; print([p["project"] for p in json.load(sys.stdin)["projects"]])')" "[None]"
DEVID=$(curl -s $B/api/admin/devices | python3 -c 'import sys,json; print([d["id"] for d in json.load(sys.stdin) if d["name"]=="otlp-box"][0])')
check "project mode: a wrong value is refused" "$(curl -s -o /dev/null -w '%{http_code}' -XPATCH $B/api/admin/devices/$DEVID -d '{"project_mode":"all"}')" 400
curl -s -o /dev/null -XPATCH $B/api/admin/devices/$DEVID -d '{"project_mode":"name"}'
check "config: the device now allows names" "$(curl -s $B/v1/config -H "x-device-token: $TOKEN")" '{"project":"name"}'
act "{\"session\":{\"id\":\"sess-otlp\",\"started_at\":\"$NOW\",\"project\":\"owner/secret-repo\"}}" >/dev/null
check "activity: with names allowed, tokens are grouped by project" "$(MS | python3 -c 'import sys,json; print([p["project"] for p in json.load(sys.stdin)["projects"]])')" "['owner/secret-repo']"
curl -s -o /dev/null -XPATCH $B/api/admin/devices/$DEVID -d '{"project_mode":"off"}'
check "project mode off forgets the stored project" "$(MS | python3 -c 'import sys,json; print([p["project"] for p in json.load(sys.stdin)["projects"]])')" "[None]"
check "activity: no text of the body is kept" "$(MS | grep -c SECRET)" 0
curl -s -o /dev/null -XDELETE $B/api/admin/devices/$DEV
check "a revoked device: 401" "$(post "$P1")" 401
rm -rf "$T"
exit $fail
