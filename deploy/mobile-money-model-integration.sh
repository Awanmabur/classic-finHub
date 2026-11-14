#!/usr/bin/env bash
# Exercises real application Mongoose models against disposable MongoDB only.
# Never connects to platform/tenant production databases.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test "$(hostname -s)" = ct-apps-prod-01
test "$(id -u)" -eq 0
test -f "$ROOT/scripts/mobile-money-model-integration.js"
test -z "${MOMO_TEST_MONGO_URI:-}" || { echo 'Unset inherited test DB overrides'; exit 1; }
test -z "${ENABLE_MOMO_COMMISSION_POSTING:-}" || { echo 'Unset posting overrides'; exit 1; }
ID="$$"
NET="classicfin-financial-it-$ID"
MONGO="classicfin-financial-db-$ID"
DB="classicfin-momo-test-$ID"
HOST="classicfin-financial-mongo"
cleanup(){
 docker rm -f "$MONGO" >/dev/null 2>&1 || true
 docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
IMAGE="$(docker inspect -f '{{.Image}}' classicfin-web-only)"
test -n "$IMAGE"
echo '=== CREATE DISPOSABLE ISOLATED NETWORK ==='
docker network create --internal "$NET" >/dev/null
echo '=== START DISPOSABLE MONGODB PRIMARY ==='
docker run -d --name "$MONGO" --network "$NET" --network-alias "$HOST" \
 --user 999:999 \
 --tmpfs /data/db:rw,nosuid,nodev,size=768m,mode=1777 \
 --tmpfs /data/configdb:rw,nosuid,nodev,size=64m,mode=1777 \
 --cap-drop ALL --security-opt no-new-privileges \
 mongo:8.0.34-noble mongod --replSet rs0 --bind_ip_all >/dev/null
for i in $(seq 1 40); do
 if test "$(docker inspect -f '{{.State.Running}}' "$MONGO")" != true; then docker logs --tail 40 "$MONGO";exit 1;fi
 if docker exec "$MONGO" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -qx 1; then break;fi
 if test "$i" -eq 40; then docker logs --tail 40 "$MONGO";exit 1;fi
 sleep 1
done
docker exec "$MONGO" mongosh --quiet \
 --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'$HOST:27017'}]})" >/dev/null
PRIMARY=0
for i in $(seq 1 40);do
 if docker exec "$MONGO" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -qx true;then PRIMARY=1;break;fi
 sleep 1
done
test "$PRIMARY" -eq 1
echo '=== ACTUAL CLASSIC FINHUB MODEL INTEGRATION ==='
docker run --rm --network "$NET" --read-only \
 --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
 --cap-drop ALL --security-opt no-new-privileges \
 --user "$(stat -c %u "$ROOT"):$(stat -c %g "$ROOT")" \
 -e NODE_ENV=test -e NODE_PATH=/app/node_modules \
 -e ENABLE_MOMO_COMMISSION_POSTING=false \
 -e MOMO_TEST_MONGO_URI="mongodb://$HOST:27017/$DB?replicaSet=rs0" \
 --mount "type=bind,src=$ROOT,dst=/workspace,readonly" \
 --workdir /workspace --entrypoint /usr/local/bin/node "$IMAGE" scripts/mobile-money-model-integration.js
echo '=== VERIFIED: DISPOSABLE TEST FINISHED ==='
echo 'Production application containers and databases were not used by this test.'
