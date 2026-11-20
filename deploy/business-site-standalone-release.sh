#!/usr/bin/env bash
# Additive business-review migration followed by established tested standalone cutover.
# Usage: sudo env CLASSICFIN_EXPECTED_SHA=<full tested git sha> bash deploy/business-site-standalone-release.sh
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = ct-apps-prod-01
ROOT="$(cd "$(dirname "$BASH_SOURCE")/.." && pwd)"
BASE="15ac54666e3de566cb758b1d55a0c06fc6541a8e"
SHA="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
test "$CLASSICFIN_EXPECTED_SHA" = "$SHA"
test -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)"
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor "$BASE" "$SHA"
test -r /etc/classicfin/web.env

echo "=== CHECK CURRENT LIVE REVISION (NO DESTRUCTIVE CHANGES) ==="
for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
  img="$(docker inspect -f '{{.Config.Image}}' "$name")"
  rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")"
  if [[ "$rev" != "$BASE" ]]; then
    echo "Unexpected live revision for $name; release blocked." >&2
    exit 1
  fi
done

echo "=== VERIFY ONLY EXPECTED FEATURE PATHS CHANGED ==="
if git -c safe.directory="$ROOT" -C "$ROOT" diff --name-only "$BASE" "$SHA" |
  grep -Ev '^(\.github/workflows/verify\.yml|public/(css/business-directory\.css|js/(business-profile|workspace)\.js)|src/(config/seo\.js|middleware/csrfProtection\.js|routes\.public\.js|platform/(models/(BusinessReview|Tenant)\.js|services/(businessDirectory|businessReviews)\.service\.js|routes/index\.js)|services/menu\.service\.js|tenant/workspace/(models|service|routes)\.js|views/(layouts/public\.ejs|original/home\.ejs|partials/business-card\.ejs|public/(tenant-landing|businesses|business-review-edit|business-review-compose)\.ejs|platform/business-reviews/index\.ejs|tenant/workspace/(index|reviews)\.ejs))|scripts/(indexes|business-reviews-indexes|business-reviews-integration|workspace-settings-integration)\.js|tests/(approved-menu|public-business-directory|public-business-website)\.test\.js|deploy/business-site-standalone-release\.sh)$'; then
  echo "Release contains unexpected changes; blocked." >&2
  exit 1
fi

echo "=== BACKWARD-COMPATIBLE REVIEW COLLECTION INDEX PREFLIGHT ==="
OLD_IMAGE="$(docker inspect -f '{{.Config.Image}}' classicfin-web-only)"
docker run --rm --network bridge --read-only \
  --env-file /etc/classicfin/web.env \
  --env NODE_PATH=/app/node_modules \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,src=$ROOT,dst=/workspace,readonly" \
  --workdir /workspace --entrypoint node "$OLD_IMAGE" \
  scripts/business-reviews-indexes.js

echo "=== TEST, CANARY AND REPLACE THREE SERVICES ==="
bash "$ROOT/deploy/standalone-ui-release.sh"

echo "=== POST-DEPLOY HEALTH AND BUSINESS DIRECTORY ==="
curl -fsS --max-time 15 https://classicfinhub.com/health/ready
curl -fsS --max-time 15 https://classicfinhub.com/businesses |
  grep -Fq 'Discover businesses'
curl -fsS --max-time 15 https://classicfinhub.com/robots.txt |
  grep -Fq 'Disallow: /t/*/my-review'
for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
  img="$(docker inspect -f '{{.Config.Image}}' "$name")"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")" = "$SHA"
done
echo "BUSINESS WEBSITE RELEASE VERIFIED: $SHA"
