#!/usr/bin/env bash
# Pinned, fail-closed release for tenant treasury and account standardization.
# Financial integration runs against a disposable LOCAL replica-set database.
set -Eeuo pipefail
umask 077

test "$(id -u)" -eq 0 || { echo "Run this release with sudo." >&2; exit 2; }
test "$(hostname -s)" = "ct-apps-prod-01" || { echo "Unexpected production host." >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED="${CLASSICFIN_EXPECTED_SHA:?Set CLASSICFIN_EXPECTED_SHA to the full reviewed commit SHA}"
[[ "$EXPECTED" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected SHA must have 40 hex characters." >&2; exit 2; }
ACTUAL="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
test "$ACTUAL" = "$EXPECTED" || { echo "Source revision changed. Deployment stopped." >&2; exit 2; }
test -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)" ||
 { echo "Release worktree has uncommitted changes." >&2; exit 2; }

NAMES=(classicfin-web-only classicfin-worker classicfin-notifications)
LIVE=""
for n in "${NAMES[@]}"; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy ||
    { echo "$n is not healthy. Release stopped." >&2; exit 2; }
  image="$(docker inspect -f '{{.Image}}' "$n")"
  sha="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] ||
    { echo "$n has no verifiable Git revision label." >&2; exit 2; }
  if [ -n "$LIVE" ] && [ "$sha" != "$LIVE" ]; then
    echo "Web and worker releases differ; investigate before replacing them." >&2
    exit 2
  fi
  LIVE="$sha"
done
if [ "$LIVE" = "$ACTUAL" ]; then
  echo "Already live at the reviewed release revision: $ACTUAL"
  exit 0
fi
git -c safe.directory="$ROOT" -C "$ROOT" cat-file -e "${LIVE}^{commit}" ||
  { echo "Current production commit unavailable in local Git history." >&2; exit 2; }
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor "$LIVE" "$ACTUAL" ||
  { echo "Live commit is not an ancestor of the release; deployment would overwrite another branch." >&2; exit 2; }

# Never pass production credentials to integration. The script itself rejects
# remote/authenticated database URIs and uses randomized disposable DB names.
TEST_URI='mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true'
echo "=== ISOLATED TREASURY INTEGRATION: no production DB credentials ==="
# The checked-out worktree may be 0700 due to umask 077 and owned by a
# different host UID than the container's node user (1000). A direct bind
# mount then exists but its source JS is unreadable (MODULE_NOT_FOUND).
# Archive only tracked files to a short-lived, readable copy. Never chmod
# the operator's home directory or access production Mongo credentials.
STAGE="$(mktemp -d /tmp/classicfin-accounts-test.XXXXXXXX)"
trap 'rm -rf -- "$STAGE"' EXIT
git -c safe.directory="$ROOT" -C "$ROOT" archive "$ACTUAL" | tar -xf - -C "$STAGE"
chmod -R a+rX "$STAGE"
test -r "$STAGE/scripts/treasury-integration.js" || {
  echo "The reviewed release does not contain the integration test." >&2; exit 2;
}
image="$(docker inspect -f '{{.Image}}' classicfin-web-only)"
docker run --rm --network host --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 \
  --env NODE_ENV=test --env "MONGO_PLATFORM_URI=$TEST_URI" \
  --env NODE_PATH=/app/node_modules \
  --env SESSION_SECRET=isolated-account-release-test-only \
  --mount "type=bind,src=$STAGE,dst=/workspace,readonly" \
  --workdir /workspace --entrypoint /bin/sh "$image" \
  -c 'test -r scripts/treasury-integration.js || { echo "Test source is unreadable inside container" >&2; exit 2; }; exec node scripts/treasury-integration.js'

echo "=== RELEASE, UNIT TESTS, BACKUP CHECK AND CANARY ==="
bash "$ROOT/deploy/standalone-ui-release.sh"
echo "RELEASE VERIFIED: $ACTUAL"
