#!/usr/bin/env bash
# Apply the reviewed dashboard-only release to the existing standalone Contabo services.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo 'Run with sudo'; exit 1; }
test "$(hostname -s)" = ct-apps-prod-01
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
BASE=c451ae0e1479f7e4dae0db3f9eac279db52312ed
git -C "$ROOT" merge-base --is-ancestor "$BASE" "$SHA"
IMAGE="classicfin:ui-${SHA:0:12}"
OLD_WEB=classicfin-web-only
OLD_WORKER=classicfin-worker
OLD_NOTIFY=classicfin-notifications
NAMES=("$OLD_WEB" "$OLD_WORKER" "$OLD_NOTIFY")
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX="-pre-ui-${STAMP}"
CANARY="classicfin-ui-canary-${STAMP}"
SAFE="/srv/classic/release-safety/classicfin/ui-${STAMP}"
LOG="$(mktemp /tmp/classicfin-ui-tests.XXXXXXXX)"
STAGE="$(mktemp -d /tmp/classicfin-ui-stage.XXXXXXXX)"
RENAMED=()
ACTIVATING=0
COMPLETED=0
exec 9>/run/lock/classicfin-standalone-release.lock
flock -n 9 || { echo 'Another release is running'; exit 1; }

rollback() {
  trap - ERR INT TERM
  set +e
  echo '=== ROLLBACK: RESTORING PREVIOUS SERVICES ==='
  docker rm -f "$CANARY" >/dev/null 2>&1 || true
  for n in "${RENAMED[@]}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  for n in "${RENAMED[@]}"; do
    docker rename "${n}${SUFFIX}" "$n" || true
    docker start "$n" >/dev/null 2>&1 || true
  done
  for n in "${NAMES[@]}"; do docker inspect -f '{{.Name}} {{.State.Status}}' "$n" || true; done
  echo "Old configuration package: $SAFE"
  exit 1
}
fail() {
  code="$1"
  if [ "$ACTIVATING" -eq 1 ] && [ "$COMPLETED" -eq 0 ]; then rollback; fi
  docker rm -f "$CANARY" >/dev/null 2>&1 || true
  rm -rf "$STAGE" "$LOG"
  exit "$code"
}
trap 'fail $?' ERR
trap 'fail 130' INT
trap 'fail 143' TERM

echo '=== 1. CHECK EXISTING PRODUCTION ==='
test -z "$(git -C "$ROOT" status --porcelain)"
for n in "${NAMES[@]}"; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy
done
test "$(systemctl show classicfin-contabo-backup.service -p Result --value)" = success
for f in web.env worker.env notifications.env; do test -s "/etc/classicfin/$f"; done
HOST="$(python3 - <<'PY'
from pathlib import Path
from urllib.parse import urlsplit
for line in Path('/etc/classicfin/web.env').read_text().splitlines():
    if line.startswith('APP_URL='):
        u=urlsplit(line.split('=',1)[1].strip().strip('"').strip("'"))
        if u.scheme!='https' or not u.hostname: raise SystemExit('Invalid APP_URL')
        print(u.hostname);break
else: raise SystemExit('Missing APP_URL')
PY
)"

echo '=== 2. PREPARE RELEASE SNAPSHOT ==='
install -d -m 0700 "$SAFE"
for n in "${NAMES[@]}"; do
  docker inspect "$n" > "$SAFE/$n.inspect.json"
  docker inspect -f '{{.Image}}' "$n" > "$SAFE/$n.image"
  docker image inspect "$(cat "$SAFE/$n.image")" >/dev/null
done
for f in web.env worker.env notifications.env; do install -m 0600 "/etc/classicfin/$f" "$SAFE/$f"; done
git -C "$ROOT" archive "$SHA" | tar -xf - -C "$STAGE"
chmod -R a+rX "$STAGE"

echo '=== 3. TEST DASHBOARD FIXES AND PRODUCTION BEHAVIOR ==='
OLD_IMAGE="$(docker inspect -f '{{.Image}}' "$OLD_WORKER")"
run_tests() {
  local with_db="$1" testspec="$2"
  local envargs=()
  if [ "$with_db" = yes ]; then envargs+=(--env PLATFORM_DB_URI=mongodb://127.0.0.1:27019/classicfin_isolated_test_db); fi
  docker run --rm --network none --read-only \
    --tmpfs /tmp:rw,exec,nosuid,size=128m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges \
    --user 1000:1000 --env NODE_ENV=test \
    --env NODE_PATH=/app/node_modules \
    --env SESSION_SECRET=isolated-unit-test-secret-not-for-production \
    "${envargs[@]}" \
    --mount "type=bind,src=$STAGE,dst=/workspace,readonly" \
    --workdir /workspace --entrypoint /bin/sh "$OLD_IMAGE" -c "$testspec" >"$LOG" 2>&1 || {
      grep -E '^not ok |^# (tests|pass|fail)' "$LOG" || true
      tail -n 25 "$LOG"
      return 1
    }
  grep -q '^# fail 0$' "$LOG"
  grep -E '^# (tests|pass|fail)' "$LOG"
}
run_tests no 'set -eu; set --; for f in tests/*.test.js; do case "$f" in tests/launch-seo.test.js|tests/mfa-seo-performance.test.js) continue;; esac; set -- "$@" "$f"; done; node --test "$@"'
run_tests yes 'node --test tests/launch-seo.test.js tests/mfa-seo-performance.test.js'

echo '=== 4. BUILD NEW IMAGE ==='
docker buildx build --pull --load --file "$ROOT/deploy/Dockerfile" \
  --label "org.opencontainers.image.revision=$SHA" --tag "$IMAGE" "$ROOT"
test "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$SHA"
NEW_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"

check_page() {
  local port="$1" path="$2"
  test "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Host: $HOST" -H "X-Forwarded-Host: $HOST" -H 'X-Forwarded-Proto: https' \
    "http://127.0.0.1:${port}${path}")" = 200
}

echo '=== 5. CANARY ==='
docker run -d --name "$CANARY" --network bridge \
  --env-file /etc/classicfin/web.env --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 128 \
  -p 127.0.0.1:3601:3000 "$IMAGE" >/dev/null
ready=0
for i in {1..30}; do
  if curl -fsS --max-time 4 http://127.0.0.1:3601/health/ready >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
test "$ready" = 1
for path in / /signin /robots.txt /sitemap.xml; do check_page 3601 "$path"; done
docker rm -f "$CANARY" >/dev/null

echo '=== 6. REPLACE STANDALONE SERVICES ==='
ACTIVATING=1
for n in "${NAMES[@]}"; do
  docker rename "$n" "${n}${SUFFIX}"
  RENAMED+=("$n")
done
for n in "${NAMES[@]}"; do docker stop --time 30 "${n}${SUFFIX}" >/dev/null; done

docker run -d --name "$OLD_WEB" --restart unless-stopped \
  --network bridge --env-file /etc/classicfin/web.env --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 128 \
  -p 127.0.0.1:3600:3000 \
  --health-cmd='node -e "fetch(\"http://127.0.0.1:3000/health/ready\",{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
  --health-interval 10s --health-timeout 5s --health-retries 3 "$IMAGE" >/dev/null

docker run -d --name "$OLD_WORKER" --restart unless-stopped \
  --network bridge --env-file /etc/classicfin/worker.env --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --cpus 0.5 --pids-limit 96 \
  --health-cmd='node scripts/worker-heartbeat.js' \
  --health-interval 10s --health-timeout 8s --health-retries 3 \
  "$IMAGE" node src/platform/workers/outbox.worker.js >/dev/null

docker run -d --name "$OLD_NOTIFY" --restart unless-stopped \
  --network bridge --env-file /etc/classicfin/notifications.env --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --cpus 0.5 --pids-limit 96 \
  --health-cmd='node scripts/notification-worker-heartbeat.js' \
  --health-interval 10s --health-timeout 8s --health-retries 3 \
  "$IMAGE" node src/tenant/workers/notification.worker.js >/dev/null

echo '=== 7. VERIFY RELEASE ==='
ready=0
for i in {1..40}; do
  ok=1
  for n in "${NAMES[@]}"; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$n" 2>/dev/null || true)"
    [ "$state" = healthy ] || ok=0
  done
  curl -fsS --max-time 4 http://127.0.0.1:3600/health/ready >/dev/null 2>&1 || ok=0
  if [ "$ok" = 1 ]; then ready=1; break; fi
  sleep 3
done
test "$ready" = 1
for n in "${NAMES[@]}"; do test "$(docker inspect -f '{{.Image}}' "$n")" = "$NEW_ID"; done
for path in / /signin /robots.txt /sitemap.xml; do check_page 3600 "$path"; done
curl -fsS --max-time 20 "https://$HOST/health/ready" >/dev/null
COMPLETED=1
ACTIVATING=0
trap - ERR INT TERM
rm -rf "$STAGE" "$LOG"
echo "CLASSIC FINHUB UI RELEASE LIVE: $SHA"
echo "Website: https://$HOST"
echo "All three services healthy. Previous containers retained: $SUFFIX"
echo "Backup coverage beyond the existing successful service is not independently verified."
