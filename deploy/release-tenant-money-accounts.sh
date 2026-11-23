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
TEST_DB_CONTAINER="classicfin-accounts-mongo-$(date -u +%s)-$RANDOM"
[[ "$TEST_DB_CONTAINER" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || {
  echo "Generated test MongoDB container name is invalid. Release stopped." >&2; exit 2;
}
DB_STARTED=0
cleanup_release_tests() {
  # Only remove a test container we actually started; never touch other Mongo.
  if [ "$DB_STARTED" -eq 1 ]; then
    docker rm -f "$TEST_DB_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$STAGE"
}
trap cleanup_release_tests EXIT
git -c safe.directory="$ROOT" -C "$ROOT" archive "$ACTUAL" | tar -xf - -C "$STAGE"
chmod -R a+rX "$STAGE"
test -r "$STAGE/scripts/treasury-integration.js" || {
  echo "The reviewed release does not contain the integration test." >&2; exit 2;
}

# Reject a financial release before provisioning test infrastructure if
# focused tenant workflows fail. Dependencies come from the currently running
# trusted app image; source comes only from the pinned Git archive.
echo "=== ACCOUNT UNIT TESTS (NO NETWORK, NO PRODUCTION CREDENTIALS) ==="
image="$(docker inspect -f '{{.Image}}' classicfin-web-only)"
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --user 1000:1000 --env NODE_ENV=test --env NODE_PATH=/app/node_modules \
  --env SESSION_SECRET=isolated-account-release-test-only \
  --mount "type=bind,src=$STAGE,dst=/workspace,readonly" \
  --workdir /workspace --entrypoint node "$image" \
  --test tests/tenant-quick-setup.test.js tests/tenant-owner-setup-cleanup.test.js \
  tests/tenant-used-account-close.test.js tests/treasury.test.js

# Do not let a temporary Mongo process starve the production app.
available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
if [ -z "$available_kib" ] || [ "$available_kib" -lt 1250000 ]; then
  echo "Insufficient available memory for safe isolated MongoDB tests on the production host (needs 1.25GB free). Release stopped." >&2
  exit 2
fi

# Fail closed instead of using an existing service on this port. This release
# owns a disposable single-node Mongo replica set, with no persisted volume,
# no credentials and a listener on host loopback only.
python3 - <<'PY'
import socket
s=socket.socket()
try:
    s.bind(('127.0.0.1', 27018))
except OSError as error:
    raise SystemExit(f"Port 27018 already in use; cannot guarantee test-database isolation: {error}")
finally:
    s.close()
PY
echo "=== START DISPOSABLE LOOPBACK MONGODB REPLICA SET ==="
docker run -d --rm --name "$TEST_DB_CONTAINER" --network host \
  --read-only --user 999:999 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=512m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1024m --cpus 2 --pids-limit 256 \
  mongo:8.0 /bin/sh -c \
  'mkdir -p /tmp/classicfin-accounts-db && exec mongod --dbpath /tmp/classicfin-accounts-db --bind_ip 127.0.0.1 --port 27018 --replSet rs0 --wiredTigerCacheSizeGB 0.25 --quiet' >/dev/null
DB_STARTED=1
db_ping=0
for i in {1..40}; do
  if docker exec "$TEST_DB_CONTAINER" mongosh --host 127.0.0.1 --port 27018 --quiet \
    --eval 'if(db.adminCommand({ping:1}).ok!==1)quit(2)' >/dev/null 2>&1; then
    db_ping=1; break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$TEST_DB_CONTAINER" 2>/dev/null || true)" != true ]; then
    echo "Disposable MongoDB exited prematurely" >&2
    docker logs --tail 40 "$TEST_DB_CONTAINER" >&2 || true
    exit 1
  fi
  sleep 2
done
if [ "$db_ping" != 1 ]; then
  echo "Disposable MongoDB did not become ready" >&2
  docker logs --tail 40 "$TEST_DB_CONTAINER" >&2 || true
  exit 1
fi
docker exec "$TEST_DB_CONTAINER" mongosh --host 127.0.0.1 --port 27018 --quiet \
  --eval 'const r=rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]});if(r.ok!==1)quit(2)'
db_primary=0
for i in {1..30}; do
  if docker exec "$TEST_DB_CONTAINER" mongosh --host 127.0.0.1 --port 27018 --quiet \
    --eval 'if(!db.hello().isWritablePrimary)quit(2)' >/dev/null 2>&1; then
    db_primary=1; break
  fi
  sleep 2
done
test "$db_primary" = 1 || {
  echo "Isolated MongoDB did not elect a PRIMARY. Deployment stopped." >&2
  exit 1
}
echo "Isolated scratch replica set is PRIMARY."
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

echo "=== REMOVE DISPOSABLE TEST DATABASE ==="
docker rm -f "$TEST_DB_CONTAINER" >/dev/null
DB_STARTED=0
echo "=== RELEASE, UNIT TESTS, BACKUP CHECK AND CANARY ==="
bash "$ROOT/deploy/standalone-ui-release.sh"
echo "RELEASE VERIFIED: $ACTUAL"
