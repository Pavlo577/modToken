#!/usr/bin/env bash
# End-to-end check of the Claude Code agent of collectors/token-tracker.mjs against `wrangler dev` (DEV_EMAIL set, fresh local D1: bun run db:local).
# Also runs against the compiled program: COLLECTOR_BIN=path/to/token-tracker bash test/claude-collector.sh
set -u
B=http://127.0.0.1:8787
HERE=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
export CODEX_HOME=$T/none TOKEN_TRACKER_HOME=$T/tt CLAUDE_CONFIG_DIR=$T/claude
fail=0
run() { if [ -n "${COLLECTOR_BIN:-}" ]; then "$COLLECTOR_BIN" "$@"; else node "$HERE/collectors/token-tracker.mjs" "$@"; fi; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
P=$CLAUDE_CONFIG_DIR/projects/-work-app; mkdir -p "$P"
OLD=$(date -u -d '-20 days' +%Y-%m-%dT%H:%M:%SZ)   # before the device exists: history (inside the 30 days the page asks for)
NOW_PLUS() { date -u -d "+$1 minutes" +%Y-%m-%dT%H:%M:%SZ; }
prompt() { echo "{\"type\":\"user\",\"timestamp\":\"$1\",\"sessionId\":\"$2\",\"message\":{\"role\":\"user\",\"content\":\"TOP SECRET PROMPT\"}}"; }
reply() { echo "{\"type\":\"assistant\",\"timestamp\":\"$1\",\"sessionId\":\"$2\",\"message\":{\"id\":\"$3\",\"model\":\"claude-sonnet-x\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"TOP SECRET ANSWER\"}],\"usage\":{\"input_tokens\":$4,\"output_tokens\":$5,\"cache_read_input_tokens\":$6,\"cache_creation_input_tokens\":0}}}"; }
F=$P/sess-1.jsonl
{ prompt $OLD sess-1; reply $OLD sess-1 h1 100 10 0; } > "$F"                        # an old turn (history)

CODE=$(curl -s -XPOST $B/api/admin/codes -d '{"name":"claude-box"}' | sed -E 's/.*"code":"([A-F0-9]+)".*/\1/')
run link "$CODE" --url $B | grep -q 'linked as "claude-box"' && echo "ok   link" || { echo "FAIL link"; fail=1; }
check "link stores where the collecting starts" "$(python3 -c "import json,os; print('since' in json.load(open(os.environ['TOKEN_TRACKER_HOME']+'/config.json')))")" True
turn() { curl -s "$B/api/admin/buckets" | python3 -c 'import sys,json; d=[r for r in json.load(sys.stdin) if r["provider"]=="claude" and r["device"]=="claude-box"]; print(sum(r["output"] for r in d), sum(r["input"] for r in d), sum(r["cache_read"] for r in d), sum(r["turns"] for r in d))'; }

out=$(run import --agent claude); echo "$out" | grep -q 'added 1' && echo "ok   history imported" || { echo "FAIL history: $out"; fail=1; }
check "the old turn arrived" "$(turn)" "10 100 0 1"
out=$(run import --agent claude); echo "$out" | grep -q 'added 0, already there 1' && echo "ok   importing again adds nothing" || { echo "FAIL second import: $out"; fail=1; }

# a turn after linking is collected by sync (and the old one is not sent again under another id)
{ prompt $(NOW_PLUS 1) sess-1; reply $(NOW_PLUS 1) sess-1 m1 20 5 300; } >> "$F"
out=$(run sync --agent claude); echo "$out" | grep -q '1 turns sent' && echo "ok   sync sends the new turn only" || { echo "FAIL sync: $out"; fail=1; }
check "totals: old + new" "$(turn)" "15 120 300 2"
out=$(run sync --agent claude); echo "$out" | grep -q '0 turns sent' && echo "ok   second sync sends nothing" || { echo "FAIL second sync: $out"; fail=1; }

# the Stop hook names the log; the turn has grown meanwhile
reply $(NOW_PLUS 2) sess-1 m2 5 7 100 >> "$F"
hk=$(printf '{"hook_event_name":"Stop","session_id":"sess-1","transcript_path":"%s","cwd":"/secret/project","last_assistant_message":"TOP SECRET ANSWER","stop_hook_active":false}' "$F" | run hook-stop --agent claude; echo "rc=$?")
check "hook-stop prints nothing and exits 0" "$hk" "rc=0"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ "$(turn)" = "22 125 400 2" ] && break; sleep 0.4; done
check "the hook synced the file it was told about (the turn grew, not duplicated)" "$(turn)" "22 125 400 2"

check "no prompt text anywhere in the state files and the log" "$(grep -rl 'TOP SECRET\|/secret/project' "$TOKEN_TRACKER_HOME" | wc -l)" 0
rm -rf "$T"
exit $fail
