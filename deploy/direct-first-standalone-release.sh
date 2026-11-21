#!/usr/bin/env bash
# Strictly pinned direct-first release, without a balance-minting migration.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = ct-apps-prod-01
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE=75bef3a5b4c0a617c18aaf9b3aeab57d2c99acd2
SHA="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
test "$CLASSICFIN_EXPECTED_SHA" = "$SHA"
test -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)"
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor "$BASE" "$SHA"

echo '=== CHECK DIRECT-FIRST RELEASE FILE SCOPE ==='
while IFS= read -r path; do
  case "$path" in
    deploy/direct-first-standalone-release.sh|\
    scripts/business-directory-doctor.js|\
    scripts/business-reviews-integration.js|\
    scripts/treasury-integration.js|\
    scripts/workspace-settings-integration.js|\
    public/js/tenant-quick-setup.js|\
    src/platform/routes/index.js|\
    src/platform/services/businessDirectory.service.js|\
    src/platform/services/businessReviews.service.js|\
    src/platform/services/tenantAdmin.service.js|\
    src/routes.public.js|\
    src/services/menu.service.js|\
    src/tenant/routes/index.js|\
    src/tenant/setup/routes.js|\
    src/tenant/treasury/funding.service.js|\
    src/tenant/treasury/service.js|\
    src/tenant/treasury/routes.js|\
    src/tenant/workspace/routes.js|\
    src/tenant/workspace/service.js|\
    src/views/platform/business-reviews/index.ejs|\
    src/views/platform/tenants/show.ejs|\
    src/views/public/business-review-compose.ejs|\
    src/views/public/business-review-edit.ejs|\
    src/views/public/tenant-landing.ejs|\
    src/views/tenant/setup/index.ejs|\
    src/views/tenant/treasury/_funding-history.ejs|\
    src/views/tenant/treasury/_funding.ejs|\
    src/views/tenant/treasury/index.ejs|\
    src/views/tenant/workspace/_operations-guide.ejs|\
    src/views/tenant/workspace/index.ejs|\
    src/views/tenant/workspace/reviews.ejs|\
    tests/public-business-directory.test.js|\
    tests/approved-menu.test.js|\
    tests/tenant-quick-setup.test.js)
      ;;
    *)
      echo "Unexpected file $path: release blocked" >&2
      exit 1
      ;;
  esac
done < <(git -c safe.directory="$ROOT" -C "$ROOT" diff --name-only "$BASE" "$SHA")

echo '=== CHECK HEALTHY PRODUCTION BASELINE ==='
for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
  image="$(docker inspect -f '{{.Config.Image}}' "$name")"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$BASE"
done
echo '=== BASELINE VERIFIED: NO DESTRUCTIVE DATA MIGRATIONS ==='

echo '=== TEST / CANARY / SAFETY SNAPSHOT / ACTIVATE ==='
bash "$ROOT/deploy/standalone-ui-release.sh"

echo '=== VERIFY PUBLIC BUSINESS DIRECTORY ==='
doctor="$(docker exec classicfin-web-only node scripts/business-directory-doctor.js)"
printf '%s\n' "$doctor"
listed="$(printf '%s' "$doctor" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["listedBusinessCount"]))')"
test "$listed" -ge 0

page="$(mktemp /tmp/classicfin-direct-page.XXXXXXXX)"
trap 'rm -f "$page"' EXIT
curl -fsS --max-time 15 -H 'Cache-Control: no-cache' \
  -o "$page" https://classicfinhub.com/businesses
grep -Fq 'Discover businesses' "$page"
if [ "$listed" -gt 0 ]; then
  if grep -Fq 'class="businessCard"' "$page"; then
    echo "LIVE DIRECTORY CARDS VERIFIED: $listed business(es)"
  else
    echo "WARNING: $listed eligible businesses, but public CDN page did not yet show cards. Check cache before marking the site verified." >&2
  fi
fi
for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
  image="$(docker inspect -f '{{.Config.Image}}' "$name")"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$SHA"
done
curl -fsS --max-time 15 https://classicfinhub.com/health/ready
echo
echo "DIRECT-FIRST RELEASE VERIFIED: $SHA"
