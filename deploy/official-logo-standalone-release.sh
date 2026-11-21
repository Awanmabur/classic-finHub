#!/usr/bin/env bash
# Exact-SHA branding-only production release. Retains the established canary/rollback path.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = ct-apps-prod-01
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE=8a1e67149ecccf53bc8c00b9ff33882c8f9d5a35
SHA="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
test -n "$CLASSICFIN_EXPECTED_SHA"
test "$CLASSICFIN_EXPECTED_SHA" = "$SHA"
test -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)"
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor "$BASE" "$SHA"

echo '=== VERIFY BRANDING-ONLY SOURCE DIFF ==='
while IFS= read -r p; do
  case "$p" in
    deploy/official-logo-standalone-release.sh|\
    public/apple-touch-icon.png|public/favicon.png|\
    public/images/classicfinhub-logo.png|public/images/classicfinhub-logo-official.png|\
    public/images/classicfinhub-mark.png|public/images/classicfinhub-social.jpg|\
    public/css/style.css|public/css/dashboard.css|public/css/dashboard-layout.css|\
    public/css/approved-tenant.css|public/offline-sw.js|public/offline.html|\
    src/config/seo.js|\
    src/views/layouts/dashboard.ejs|src/views/layouts/public.ejs|\
    src/views/partials/dashboard-sidebar.ejs|src/views/partials/marketing-footer.ejs|\
    src/views/original/*.ejs|src/views/auth/*.ejs|\
    src/views/errors/request.ejs|\
    src/views/tenant/mobile-money/acknowledgement.ejs|\
    src/views/tenant/money-transfer/acknowledgement.ejs|\
    tests/official-logo-branding.test.js)
      ;;
    *)
      echo "Blocked unreviewed file in logo release: $p" >&2
      exit 1
      ;;
  esac
done < <(git -c safe.directory="$ROOT" -C "$ROOT" diff --name-only "$BASE" "$SHA")

echo '=== VERIFY USER-SUPPLIED ORIGINAL ARTWORK ==='
EXPECTED=d8cacd000cbc45c3816c1fe6442c0b8ef77421305318066d7a696c1413b4a857
REAL="$(sha256sum "$ROOT/public/images/classicfinhub-logo.png" | awk '{print $1}')"
test "$REAL" = "$EXPECTED"
cmp "$ROOT/public/images/classicfinhub-logo.png" \
    "$ROOT/public/images/classicfinhub-logo-official.png"
test -s "$ROOT/public/images/classicfinhub-mark.png"
test -s "$ROOT/public/favicon.png"
test -s "$ROOT/public/apple-touch-icon.png"
test -s "$ROOT/public/images/classicfinhub-social.jpg"

echo '=== VERIFY HEALTHY CURRENT PRODUCTION ==='
for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
  img="$(docker inspect -f '{{.Config.Image}}' "$name")"
  test "$(docker image inspect -f \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")" = "$BASE"
done

echo '=== TEST, CANARY, RETAIN ROLLBACK, ACTIVATE ==='
bash "$ROOT/deploy/standalone-ui-release.sh"

echo '=== VERIFY EXACT CONTAINER REVISION AND LOGO BYTES ==='
for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
  img="$(docker inspect -f '{{.Config.Image}}' "$name")"
  test "$(docker image inspect -f \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")" = "$SHA"
done
test "$(docker exec classicfin-web-only sha256sum /app/public/images/classicfinhub-logo.png | awk '{print $1}')" = "$EXPECTED"

echo '=== VERIFY PUBLIC ASSET, BRANDING AND READINESS ==='
TMP="$(mktemp -d /tmp/classicfin-brand-verify.XXXXXXXX)"
trap 'rm -rf "$TMP"' EXIT
BASEURL=https://classicfinhub.com
SHORTSHA="$(printf '%s' "$SHA" | cut -c1-12)"
curl -fsS --max-time 20 --retry 2 -H 'Cache-Control: no-cache' \
  -o "$TMP/logo.png" "$BASEURL/images/classicfinhub-logo.png?v=$SHORTSHA"
test "$(sha256sum "$TMP/logo.png" | awk '{print $1}')" = "$EXPECTED" || {
  echo 'Public logo differs from verified source. Check CDN/static cache before confirming branding.' >&2
  exit 1
}
for path in / /signin /signup /businesses; do
  name="$(printf '%s' "$path" | tr '/' '_')"
  curl -fsS --max-time 20 --retry 2 -H 'Cache-Control: no-cache' \
    -o "$TMP/$name.html" "$BASEURL$path"
done
grep -Fq 'classicfinhub-mark.png' "$TMP/_.html"
grep -Fq 'classicfinhub-logo-official.png' "$TMP/_.html"
grep -Fq 'favicon.png' "$TMP/_signin.html"
curl -fsS --max-time 15 "$BASEURL/health/ready"
echo
echo "OFFICIAL CLASSICFIN LOGO PRODUCTION VERIFIED: $SHA"
