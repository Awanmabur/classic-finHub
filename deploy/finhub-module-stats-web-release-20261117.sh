#!/usr/bin/env bash
# Web-only corrective release: real module summary stats and desktop four-card layout.
# No database migration, no worker replacement, no change to transaction approval.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = "ct-apps-prod-01"
exec 9>/run/lock/classicfin-web-fees-release.lock
flock -n 9
REPO=/srv/classic/apps/classicfin
BRANCH=fix/finhub-module-stats-and-grid-20261117
SHA=c3cf5c1e6e2b17eecd58ff7cda5bbc410ee10d75
WT=/home/classicdeploy/classicfin-summary-c3cf5c1e
IMAGE=classicfin:summary-c3cf5c1e6e2b
APP=classicfin-web-only
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACK="${APP}-pre-stats-${STAMP}"
CANARY="classicfin-stats-canary-${STAMP}-$$"
ROLLBACK=0
DONE=0

recover(){
 local rc="${1:-$?}"
 trap - ERR INT TERM
 set +e
 docker rm -f "$CANARY" >/dev/null 2>&1
 if (( ROLLBACK == 1 && DONE == 0 )); then
  echo 'WEB CUTOVER FAILED: restoring original container'
  docker rm -f "$APP" >/dev/null 2>&1
  docker rename "$BACK" "$APP" || echo 'WARNING: Rename back failed'
  docker start "$APP" >/dev/null 2>&1 || echo 'WARNING: Original app did not start'
  if test "$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)" = healthy; then
   echo 'Original web container recovered healthy'
  else
   echo 'CRITICAL: Verify original web container health immediately'
  fi
 fi
 echo "Release exited with code $rc"
 exit "$rc"
}
trap 'recover $?' ERR
trap 'recover 130' INT
trap 'recover 143' TERM

echo '=== 1. CHECK CURRENT PRODUCTION AND BACKUP ==='
for name in "$APP" classicfin-worker classicfin-notifications; do
 test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
done
test "$(docker inspect "$APP" -f '{{.Config.Image}}')" = 'classicfin:stats-6304bab94983'
test "$(docker inspect "$APP" -f '{{.HostConfig.NetworkMode}}')" = bridge
test "$(docker inspect "$APP" -f '{{len .Mounts}}')" = 0
docker port "$APP" 3000/tcp | grep -Fxq '127.0.0.1:3600'
test "$(systemctl show classicfin-contabo-backup.service -p Result --value)" = success
test -s /etc/classicfin/web.env
cd /var/backups/classicfin
LATEST="$(ls -1t classicfin-full-*.gpg | head -1)"
sha256sum --check "$LATEST.sha256"
test "$(date +%s)" -ge "$(stat -c %Y "$LATEST")"
cd /
MEM_MB="$(awk '/MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
DISK_KB="$(df -Pk "$(docker info --format '{{.DockerRootDir}}')" | awk 'NR==2{print $4}')"
(( MEM_MB >= 1800 && DISK_KB >= 2097152 ))

echo '=== 2. PIN VERIFIED SOURCE WITHOUT CHANGING LIVE WORKTREE ==='
runuser -u classicdeploy -- git -C "$REPO" fetch --no-tags origin \
 "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
test "$(runuser -u classicdeploy -- git -C "$REPO" rev-parse "origin/$BRANCH")" = "$SHA"
if ! test -d "$WT"; then
 runuser -u classicdeploy -- git -C "$REPO" worktree add --detach "$WT" "$SHA"
fi
test "$(runuser -u classicdeploy -- git -C "$WT" rev-parse HEAD)" = "$SHA"
test -z "$(runuser -u classicdeploy -- git -C "$WT" status --porcelain)"
test -f "$WT/src/tenant/services/financeOverview.service.js"
test -f "$WT/src/views/tenant/partials/module-finance.ejs"
test -f "$WT/tests/finhub-report-stats-visibility.test.js"
grep -Fq "include('partials/module-finance'" "$WT/src/views/tenant/operation-workspace.ejs"

echo '=== 3. BUILD PINNED APPLICATION IMAGE ==='
docker buildx build --pull --load -f "$WT/deploy/Dockerfile" \
 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE" "$WT"
test "$(docker image inspect "$IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$SHA"
NEWID="$(docker image inspect "$IMAGE" -f '{{.Id}}')"

echo '=== 4. VERIFY MODULE SUMMARY ARTIFACTS IN BUILT IMAGE ==='
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true "$IMAGE" node -e \
 'const fs=require("fs");const check=(p,t)=>{const src=fs.readFileSync(p,"utf8");if(!src.includes(t))process.exit(1)};check("src/views/tenant/operation-workspace.ejs","module-finance");check("src/tenant/routes/operationWorkspace.routes.js","data.financeOverview");check("src/views/tenant/mobile-money/report.ejs","module-finance");check("public/css/dashboard-layout.css",":not(.overviewStatsGrid)");console.log("Module summary runtime artifacts: PASS")'
echo '=== 5. HEALTHY CANARY BEFORE ANY DOWNTIME ==='
docker run -d --name "$CANARY" --network bridge \
 --env-file /etc/classicfin/web.env \
 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
 --cap-drop ALL --security-opt no-new-privileges:true \
 --memory 512m --cpus 1 --pids-limit 128 \
 -p 127.0.0.1:3601:3000 "$IMAGE" >/dev/null
READY=0
for i in $(seq 1 35); do
 if curl -fsS --max-time 5 http://127.0.0.1:3601/health/ready >/dev/null 2>&1; then READY=1; break; fi
 sleep 2
done
test "$READY" = 1
echo '=== VERIFY SERVED DESKTOP GRID CSS BEFORE CUTOVER ==='
CSS="$(mktemp /tmp/classicfin-summary-css-XXXXXX)"
curl -fsS --max-time 10 http://127.0.0.1:3601/css/dashboard-layout.css -o "$CSS"
grep -Fq ':not(.overviewStatsGrid):not(.moduleStatsGrid)' "$CSS"
grep -Fq 'repeat(4,minmax(0,1fr))!important' "$CSS"
rm -f "$CSS"
docker rm -f "$CANARY" >/dev/null

echo '=== 6. WEB-ONLY CUTOVER (DATABASE AND WORKERS UNCHANGED) ==='
docker rename "$APP" "$BACK"
ROLLBACK=1
docker stop --time 25 "$BACK" >/dev/null
docker run -d --name "$APP" --restart unless-stopped \
 --network bridge --env-file /etc/classicfin/web.env \
 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
 --cap-drop ALL --security-opt no-new-privileges:true \
 --memory 512m --cpus 1 --pids-limit 128 \
 -p 127.0.0.1:3600:3000 \
 --health-cmd='node -e "fetch(\"http://127.0.0.1:3000/health/ready\",{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
 --health-interval 10s --health-timeout 5s --health-retries 3 \
 "$IMAGE" >/dev/null
READY=0
for i in $(seq 1 40); do
 if test "$(docker inspect -f '{{.State.Health.Status}}' "$APP")" = healthy &&
    curl -fsS --max-time 5 http://127.0.0.1:3600/health/ready >/dev/null 2>&1; then READY=1; break; fi
 sleep 3
done
test "$READY" = 1
test "$(docker inspect "$APP" -f '{{.Image}}')" = "$NEWID"
for name in classicfin-worker classicfin-notifications; do
 test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
done
curl -fsS --max-time 15 https://classicfinhub.com/health/ready >/dev/null
DONE=1
trap - ERR INT TERM
echo "WEB RELEASE LIVE: $SHA"
echo "Previous container preserved: $BACK"
echo 'Production database and worker images were not changed.'
