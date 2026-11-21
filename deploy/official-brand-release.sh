#!/usr/bin/env bash
# Official ClassicFin Hub branding only. No financial business logic changes.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = ct-apps-prod-01
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE=8a1e67149ecccf53bc8c00b9ff33882c8f9d5a35
SHA="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
test "$CLASSICFIN_EXPECTED_SHA" = "$SHA"
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor "$BASE" "$SHA"
test -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)"

echo '=== CHECK BRANDING-ONLY DIFF ==='
while IFS= read -r path; do
  case "$path" in
    deploy/official-brand-release.sh|tests/official-logo-branding.test.js|\
    public/favicon.png|public/apple-touch-icon.png|\
    public/images/classicfinhub-logo.png|public/images/classicfinhub-logo-official.png|\
    public/images/classicfinhub-mark.png|public/images/classicfinhub-social.jpg|\
    public/css/style.css|public/css/dashboard.css|public/css/approved-tenant.css|\
    public/offline.html|public/offline-sw.js|src/config/seo.js|\
    src/views/layouts/public.ejs|src/views/layouts/dashboard.ejs|\
    src/views/partials/dashboard-sidebar.ejs|src/views/partials/marketing-footer.ejs|\
    src/views/original/*.ejs|src/views/auth/*.ejs|src/views/errors/request.ejs|\
    src/views/tenant/mobile-money/acknowledgement.ejs|\
    src/views/tenant/money-transfer/acknowledgement.ejs)
      ;;
    *) echo "Unexpected modification outside branding: $path" >&2; exit 1 ;;
  esac
done < <(git -c safe.directory="$ROOT" -C "$ROOT" diff --name-only "$BASE" "$SHA")
echo '=== VERIFY EXACT USER-PROVIDED LOGO CONTENT ==='
printf '%s  %s\n' \
  'd8cacd000cbc45c3816c1fe6442c0b8ef77421305318066d7a696c1413b4a857' \
  "$ROOT/public/images/classicfinhub-logo-official.png" | sha256sum -c -
cmp "$ROOT/public/images/classicfinhub-logo.png" \
    "$ROOT/public/images/classicfinhub-logo-official.png"
printf '%s  %s\n' \
  'c8d11cc006bed4f1a060327135a8b8b7ca574f417499f283017495dab8f2170b' \
  "$ROOT/public/images/classicfinhub-mark.png" | sha256sum -c -

echo '=== CONFIRM HEALTHY PRODUCTION REVISION ==='
for n in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy
  image="$(docker inspect -f '{{.Config.Image}}' "$n")"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$BASE"
done

echo '=== RUN TESTS, CANARY AND CONTROLLED SERVICE REPLACEMENT ==='
bash "$ROOT/deploy/standalone-ui-release.sh"

echo '=== VERIFY NEW PUBLIC BRAND ASSETS ==='
tmp="$(mktemp -d /tmp/classicfin-brand-check.XXXXXXXX)"
trap 'rm -rf "$tmp"' EXIT
for path in \
  images/classicfinhub-logo-official.png \
  images/classicfinhub-mark.png \
  images/classicfinhub-social.jpg \
  favicon.png \
  apple-touch-icon.png
do
  curl -fsS --max-time 20 -H 'Cache-Control: no-cache' \
    -o "$tmp/$(basename "$path")" "https://classicfinhub.com/$path"
  cmp "$tmp/$(basename "$path")" "$ROOT/public/$path"
done
curl -fsS --max-time 15 -o "$tmp/home.html" https://classicfinhub.com/
grep -Fq '/images/classicfinhub-mark.png' "$tmp/home.html"
grep -Fq '/images/classicfinhub-social.jpg' "$tmp/home.html"
curl -fsS --max-time 15 -o "$tmp/signin.html" https://classicfinhub.com/signin
grep -Fq '/images/classicfinhub-mark.png' "$tmp/signin.html"
for n in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy
  image="$(docker inspect -f '{{.Config.Image}}' "$n")"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$SHA"
done
curl -fsS --max-time 15 https://classicfinhub.com/health/ready
echo
echo "OFFICIAL LOGO RELEASE VERIFIED: $SHA"
