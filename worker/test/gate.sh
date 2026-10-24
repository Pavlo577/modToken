#!/usr/bin/env bash
# Run against `wrangler dev` started WITHOUT DEV_EMAIL (production-like): the Access gate must hold and /v1/* must need a device token.
set -u
B=http://127.0.0.1:8787
c() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
check "admin needs Access" "$(c $B/api/admin/me)" 401
check "forged email header ignored" "$(c $B/api/admin/me -H 'cf-access-authenticated-user-email: evil@x.com')" 401
check "forged JWT rejected" "$(c $B/api/admin/me -H 'cf-access-jwt-assertion: a.b.c')" 401
check "no device can be added without Access" "$(c -XPOST $B/api/admin/devices -d '{"name":"x"}')" 401
check "OTLP logs need a device token" "$(c -XPOST $B/v1/logs -H 'content-type: application/json' -d '{}')" 401
check "old collector endpoints are gone" "$(c -XPOST $B/api/ingest -d '[]')" 404
exit $fail
