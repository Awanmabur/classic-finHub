#!/usr/bin/env bash
# Read-only, network-isolated Classic FinHub Mobile Money financial preflight.
# No DB credentials are loaded; no containers are replaced; no production data is written.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(hostname -s)" = ct-apps-prod-01 ] || { echo 'Wrong host'; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo'; exit 1; }
[ -f "$ROOT/src/tenant/pricing/commissionPayoutService.js" ] || { echo 'Missing source files'; exit 1; }
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor d0a00582b7d1e82877a81b619df1db078d0de24d HEAD

IMAGE="$(docker inspect -f '{{.Image}}' classicfin-web-only)"
[ -n "$IMAGE" ] || { echo 'Current production image unavailable'; exit 1; }
LOG="$(mktemp /tmp/classicfin-financial-preflight.XXXXXXXX)"
trap 'rm -f "$LOG"' EXIT

run_test(){
  local test_spec="$1"
  docker run --rm --network none --read-only \
   --tmpfs /tmp:rw,exec,nosuid,size=128m,mode=1777 \
   --cap-drop ALL --security-opt no-new-privileges \
   --user 1000:1000 \
   --env NODE_ENV=test --env NODE_PATH=/app/node_modules \
   --env SESSION_SECRET=isolated-financial-preflight-secret-not-for-production \
   --env PLATFORM_DB_URI=mongodb://127.0.0.1:27019/classicfin_isolated_test_db \
   --mount "type=bind,src=$ROOT,dst=/workspace,readonly" \
   --workdir /workspace --entrypoint /bin/sh "$IMAGE" \
   -c "$test_spec" >"$LOG" 2>&1 || {
     grep -E '^not ok |^# (tests|pass|fail)' "$LOG" || true
     tail -n 55 "$LOG"
     exit 1
   }
  grep -q '^# fail 0$' "$LOG" || { cat "$LOG"; exit 1; }
  grep -E '^# (tests|pass|fail)' "$LOG"
}
echo "PRE-FLIGHT COMMIT: $(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
echo '=== UNIT, FINANCIAL AND VIEW CONTRACT TESTS ==='
run_test 'set -eu; set --; for f in tests/*.test.js; do case "$f" in tests/launch-seo.test.js|tests/mfa-seo-performance.test.js) continue;; esac; set -- "$@" "$f"; done; node --test "$@"'
echo '=== SEO AND MFA SMOKE CONTRACTS ==='
run_test 'node --test tests/launch-seo.test.js tests/mfa-seo-performance.test.js'
echo 'PREFLIGHT PASSED. PRODUCTION IMAGE, FINANCIAL BOOKS AND DATABASES UNCHANGED.'
echo 'This does not authorize ENABLE_MOMO_COMMISSION_POSTING or a production financial release.'
