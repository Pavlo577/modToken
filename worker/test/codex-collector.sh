#!/usr/bin/env bash
# End-to-end check of collectors/codex.mjs against `wrangler dev` (DEV_EMAIL set, fresh local D1: bun run db:local).
set -u
B=http://127.0.0.1:8787
HERE=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
export CODEX_HOME=$T/codex TOKEN_TRACKER_HOME=$T/tt
fail=0
# COLLECTOR_BIN=path/to/token-tracker tests the compiled program instead of the script
run() { if [ -n "${COLLECTOR_BIN:-}" ]; then "$COLLECTOR_BIN" "$@"; else node "$HERE/collectors/codex.mjs" "$@"; fi; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
mkdir -p "$CODEX_HOME/sessions/2026/10/24" "$CODEX_HOME/archived_sessions"
F=$CODEX_HOME/sessions/2026/10/24/rollout-2026-10-24T10-00-00-th9.jsonl
u() { echo "{\"input_tokens\":$1,\"cached_input_tokens\":$2,\"cache_write_input_tokens\":0,\"output_tokens\":$3,\"reasoning_output_tokens\":0,\"total_tokens\":$(( $1 + $3 ))}"; }
line() { echo "{\"timestamp\":\"$1\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":$(u $2 $3 $4),\"last_token_usage\":$(u $5 $6 $7)},\"rate_limits\":$8}}"; }
RL='{"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":4102444800},"secondary":{"used_percent":30,"window_minutes":10080,"resets_at":4102444800},"plan_type":"plus"}'
{
  echo '{"timestamp":"2026-10-24T10:00:00Z","type":"session_meta","payload":{"id":"th9","timestamp":"2026-10-24T10:00:00Z","cwd":"/secret/project"}}'
  echo '{"timestamp":"2026-10-24T10:00:01Z","type":"turn_context","payload":{"turn_id":"tA","model":"gpt-5-codex"}}'
  echo '{"timestamp":"2026-10-24T10:00:02Z","type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"TOP SECRET ANSWER"}]}}'
  line 2026-10-24T10:00:05Z 1000 800 50 1000 800 50 "$RL"
  line 2026-10-24T10:00:06Z 1000 800 50 1000 800 50 null
} > "$F"

CODE=$(curl -s -XPOST $B/api/admin/codes -d '{"name":"collector-box"}' | sed -E 's/.*"code":"([A-F0-9]+)".*/\1/')
run link "$CODE" --url $B | grep -q 'linked as "collector-box"' && echo "ok   link" || { echo "FAIL link"; fail=1; }
check "token not printed or world-readable" "$(stat -c %a "$TOKEN_TRACKER_HOME/config.json")" 600
out=$(run sync); echo "$out" | grep -q '1 turns sent, limits updated' && echo "ok   first sync" || { echo "FAIL first sync: $out"; fail=1; }
turn() { curl -s "$B/api/admin/buckets" | python3 -c 'import sys,json; d=[r for r in json.load(sys.stdin) if r["provider"]=="codex" and r["device"]=="collector-box"]; print(sum(r["output"] for r in d), sum(r["input"] for r in d), sum(r["cache_read"] for r in d), sum(r["turns"] for r in d))'; }
check "turn stored (output input cache turns)" "$(turn)" "50 200 800 1"
check "limits stored as codex" "$(curl -s "$B/api/admin/limits" | python3 -c 'import sys,json; print(sorted((r["provider"], r["kind"], r["percent"]) for r in json.load(sys.stdin) if r["provider"]=="codex" and r["device"]=="collector-box"))')" "[('codex', 'five_hour', 12.5), ('codex', 'seven_day', 30)]"
out=$(run sync); echo "$out" | grep -q '0 read, 0 turns sent' && echo "ok   second sync sends nothing" || { echo "FAIL second sync: $out"; fail=1; }
line 2026-10-24T10:00:20Z 3000 2500 120 2000 1700 70 null >> "$F"
out=$(run sync); echo "$out" | grep -q '1 turns sent' && echo "ok   a grown turn is sent again" || { echo "FAIL third sync: $out"; fail=1; }
check "the turn grew, not duplicated" "$(turn)" "120 500 2500 1"
check "full resend changes nothing" "$(run sync --full >/dev/null; turn)" "120 500 2500 1"
check "no prompt text in the state files" "$(grep -rl 'TOP SECRET' "$TOKEN_TRACKER_HOME" | wc -l)" 0
rm -rf "$T"
exit $fail
