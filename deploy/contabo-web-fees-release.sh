#!/usr/bin/env bash
# Web-only Classic FinHub release while notification worker tenant permissions are unresolved.
# Fail closed on unexpected container topology, keep the old image and container.
set -Eeuo pipefail
umask 077
test "$(id -u)" = 0
test "$(hostname -s)" = ct-apps-prod-01
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
test -n "${CLASSICFIN_EXPECTED_SHA:-}"
test "$SHA" = "$CLASSICFIN_EXPECTED_SHA"
test -z "$(GIT_OPTIONAL_LOCKS=0 git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)"
exec 9>/run/lock/classicfin-web-fees-release.lock
flock -n 9
APP=classicfin-web-only
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACK="${APP}-pre-fees-$STAMP"
CANARY="classicfin-fees-canary-$STAMP"
IMAGE="classicfin:fees-$(printf '%s' "$SHA" | cut -c1-12)"
SAFE="/srv/classic/release-safety/classicfin/web-fees-$STAMP"
install -d -m 0700 "$SAFE"
ROLLBACK=0
DONE=0
recover(){
 code=${1:-$?}
 trap - ERR INT TERM
 set +e
 docker rm -f "$CANARY" >/dev/null 2>&1
 if [ "$ROLLBACK" -eq 1 ] && [ "$DONE" -eq 0 ]; then
  echo 'CUTOVER FAILED: restoring original web container'
  docker rm -f "$APP" >/dev/null 2>&1
  docker rename "$BACK" "$APP"
  docker start "$APP"
 fi
 echo "Protected release evidence: $SAFE"
 exit "$code"
}
trap recover ERR
trap 'recover 130' INT
trap 'recover 143' TERM

echo '=== PRODUCTION SAFETY CHECK ==='
for n in "$APP" classicfin-worker classicfin-notifications; do
 test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy
 docker inspect "$n" > "$SAFE/$n.inspect.json"
 docker inspect -f '{{.Image}}' "$n" > "$SAFE/$n.image"
 chmod 0600 "$SAFE/$n.inspect.json" "$SAFE/$n.image"
done
test "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$APP")" = bridge
test "$(docker inspect -f '{{len .Mounts}}' "$APP")" = 0
label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$APP")"
test -z "$label" || test "$label" = '<no value>'
docker port "$APP" 3000/tcp | grep -Fxq '127.0.0.1:3600'
test -s /etc/classicfin/web.env
test "$(systemctl show classicfin-contabo-backup.service -p Result --value)" = success
test -d "$ROOT/node_modules"
docker image inspect node:22-bookworm-slim >/dev/null

echo '=== ISOLATED TESTS: NO LIVE DB ACCESS ==='
docker run --rm --network none --cpus 1 --memory 1536m \
 --user "$(stat -c %u "$ROOT"):$(stat -c %g "$ROOT")" \
 -e HOME=/tmp -e NODE_ENV=test \
 -v "$ROOT:/work" -w /work node:22-bookworm-slim sh -c \
 'npm run check && node --test --test-concurrency=2 tests/*.test.js' \
 > "$SAFE/test.log" 2>&1 || {
 grep -A 20 '^not ok ' "$SAFE/test.log" | tail -160 || true
 tail -35 "$SAFE/test.log"
 exit 1
}
grep -E '^# (tests|pass|fail)' "$SAFE/test.log"
grep -q '^# fail 0$' "$SAFE/test.log"

echo '=== BUILD REVIEWED SOURCE AND CANARY ==='
docker buildx build --pull --load -f "$ROOT/deploy/Dockerfile" \
 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE" "$ROOT"
test "$(docker image inspect "$IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$SHA"
NEWID="$(docker image inspect "$IMAGE" -f '{{.Id}}')"
docker run -d --name "$CANARY" --network bridge --env-file /etc/classicfin/web.env \
 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL \
 --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 128 \
 -p 127.0.0.1:3601:3000 "$IMAGE" >/dev/null
ready=0
for _ in {1..30}; do
 if curl -fsS --max-time 5 http://127.0.0.1:3601/health/ready >/dev/null 2>&1; then ready=1; break; fi
 sleep 2
done
test "$ready" = 1
docker rm -f "$CANARY" >/dev/null

echo '=== WEB ONLY CUTOVER; WORKERS UNCHANGED ==='
docker rename "$APP" "$BACK"
ROLLBACK=1
docker stop --time 25 "$BACK" >/dev/null
docker run -d --name "$APP" --restart unless-stopped \
 --network bridge --env-file /etc/classicfin/web.env --read-only \
 --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL \
 --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 128 \
 -p 127.0.0.1:3600:3000 \
 --health-cmd='node -e "fetch(\"http://127.0.0.1:3000/health/ready\",{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
 --health-interval 10s --health-timeout 5s --health-retries 3 \
 "$IMAGE" >/dev/null
ready=0
for _ in {1..40}; do
 if test "$(docker inspect -f '{{.State.Health.Status}}' "$APP")" = healthy &&
 curl -fsS --max-time 5 http://127.0.0.1:3600/health/ready >/dev/null 2>&1; then ready=1; break; fi
 sleep 3
done
test "$ready" = 1
test "$(docker inspect "$APP" -f '{{.Image}}')" = "$NEWID"
test "$(docker inspect classicfin-worker -f '{{.State.Health.Status}}')" = healthy
test "$(docker inspect classicfin-notifications -f '{{.State.Health.Status}}')" = healthy
curl -fsS --max-time 15 https://classicfinhub.com/health/ready >/dev/null
DONE=1
trap - ERR INT TERM
echo "WEB RELEASE LIVE: $SHA"
echo "Existing workers unchanged. Previous web preserved as $BACK"
echo "Protected release evidence: $SAFE"
echo 'Owner risk-alert delivery across the other tenants is pending MongoDB worker access.'
