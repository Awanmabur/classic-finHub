#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

test "$(id -u)" -eq 0
test "$(hostname -s)" = "ct-apps-prod-01"
SHA=20f62fa7dad704bce7d590d9b365b3135fed1bf9
BRANCH=fix/forex-separate-buy-sell-rates-20261116
REPO=/srv/classic/apps/classicfin
WT=/home/classicdeploy/classicfin-forex-20f62fa7
APP=classicfin-web-only
WORKER=classicfin-worker
NOTIFY=classicfin-notifications
IMAGE="classicfin:forex-${SHA:0:12}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACK="${APP}-pre-forex-${STAMP}"
CANARY="classicfin-forex-canary-${STAMP}-$$"
RESTORE="classicfin-forex-restore-${STAMP}-$$"
BACKUP_ROOT=/var/backups/classicfin
BACKUP_KEY=/etc/classicfin/backup-key
RESTORE_LOG="$(mktemp)"
STOPPED=0
MIGRATION_STARTED=0
RENAMED=0
DONE=0

fail() {
  local rc="${1:-1}"
  trap - ERR INT TERM
  set +e
  docker rm -f "$CANARY" "$RESTORE" >/dev/null 2>&1
  rm -f "$RESTORE_LOG"
  if (( STOPPED == 1 && MIGRATION_STARTED == 0 )); then
    echo 'Failure before DB migration: restarting the original services.'
    for svc in "$APP" "$WORKER" "$NOTIFY"; do
      if docker inspect "$svc" >/dev/null 2>&1; then
        docker start "$svc" >/dev/null 2>&1 || true
      fi
    done
  elif (( MIGRATION_STARTED == 1 && DONE == 0 )); then
    if (( RENAMED == 1 )); then
      docker stop "$APP" >/dev/null 2>&1
    fi
    echo 'PRODUCTION HELD OFFLINE: Migration began, do not start old Forex application.'
    if (( RENAMED == 1 )); then echo "Old web container: $BACK"; else echo "Old web container: $APP"; fi
    echo 'Escalate for index-state verification before retry/rollback.'
  fi
  echo "RELEASE STOPPED (exit $rc)."
  exit "$rc"
}
trap 'fail $?' ERR
trap 'fail 130' INT
trap 'fail 143' TERM

exec 9>/run/lock/classicfin-forex-release.lock
flock -n 9

for n in "$APP" "$WORKER" "$NOTIFY"; do
  test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy
done
test "$(docker inspect -f '{{.Config.Image}}' "$APP")" = 'classicfin:fees-610e30573975'
test "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$APP")" = bridge
test "$(docker inspect -f '{{len .Mounts}}' "$APP")" = 0
docker port "$APP" 3000/tcp | grep -Fxq '127.0.0.1:3600'
test -s /etc/classicfin/web.env
test -s "$BACKUP_KEY"
test -d "$BACKUP_ROOT"
docker image inspect mongo:8.0 >/dev/null

FREE_KB="$(df -Pk "$(docker info --format '{{.DockerRootDir}}')" | awk 'NR==2{print $4}')"
MEM_MB="$(awk '/MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
(( FREE_KB >= 2097152 && MEM_MB >= 1800 ))

echo '=== 1. FETCH REVIEWED SOURCE ==='
runuser -u classicdeploy -- git -C "$REPO" fetch --no-tags origin \
  "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
test "$(runuser -u classicdeploy -- git -C "$REPO" rev-parse "origin/$BRANCH")" = "$SHA"
if ! test -d "$WT"; then
  runuser -u classicdeploy -- git -C "$REPO" worktree add --detach "$WT" "$SHA"
fi
test "$(runuser -u classicdeploy -- git -C "$WT" rev-parse HEAD)" = "$SHA"
test -z "$(runuser -u classicdeploy -- git -C "$WT" status --porcelain)"

echo '=== 2. BUILD PINNED WEB IMAGE ==='
docker buildx build --pull --load -f "$WT/deploy/Dockerfile" \
  --label "org.opencontainers.image.revision=$SHA" \
  -t "$IMAGE" "$WT"
test "$(docker image inspect "$IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$SHA"

echo '=== 3. FOREX UNIT TESTS ==='
docker run --rm --network none --memory 768m --cpus 1 \
  -e NODE_ENV=test \
  -v "$WT/tests:/app/tests:ro" \
  "$IMAGE" node --test tests/forex.test.js

echo '=== 4. CANARY HEALTH ==='
docker run -d --name "$CANARY" --network bridge \
  --env-file /etc/classicfin/web.env \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --cpus 1 --pids-limit 128 \
  -p 127.0.0.1:3601:3000 "$IMAGE" >/dev/null
READY=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 4 http://127.0.0.1:3601/health/ready >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done
test "$READY" = 1
docker rm -f "$CANARY" >/dev/null

echo '=== 5. FOUR TENANT MIGRATION DRY-RUNS ==='
TENANTS=(classic classic-2 ghaja john-ajuot-magot)
for tenant in "${TENANTS[@]}"; do
  docker run --rm --network bridge \
    --memory 512m --cpus 1 --pids-limit 128 \
    --env-file /etc/classicfin/web.env \
    "$IMAGE" node scripts/forex-rate-side-migrate.js "--tenant=$tenant"
done

echo '=== 6. BEGIN CONTROLLED MAINTENANCE ==='
PREV_BACKUP="$(ls -1t "$BACKUP_ROOT"/classicfin-full-*.gpg | head -1)"
STOPPED=1
docker stop --time 25 "$APP" "$WORKER" "$NOTIFY" >/dev/null
for n in "$APP" "$WORKER" "$NOTIFY"; do
  test "$(docker inspect -f '{{.State.Status}}' "$n")" = exited
done

echo '=== 7. CONSISTENT FRESH BACKUP ==='
systemctl start classicfin-contabo-backup.service
test "$(systemctl show classicfin-contabo-backup.service -p Result --value)" = success
LATEST="$(ls -1t "$BACKUP_ROOT"/classicfin-full-*.gpg | head -1)"
test "$LATEST" != "$PREV_BACKUP"
(cd "$BACKUP_ROOT" && sha256sum -c "$(basename "$LATEST").sha256")
gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file "$BACKUP_KEY" --decrypt "$LATEST" | gzip -t
echo "Fresh verified backup: $LATEST"

echo '=== 8. RESTORE FRESH BACKUP IN ISOLATION ==='
docker run -d --rm --name "$RESTORE" --network none \
  --memory 1024m --memory-swap 1024m --cpus 1 --pids-limit 128 \
  mongo:8.0 mongod --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 0.25 >/dev/null
READY=0
for i in $(seq 1 40); do
  if docker exec "$RESTORE" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -qx 1; then
    READY=1; break
  fi
  sleep 2
done
test "$READY" = 1
if ! gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file "$BACKUP_KEY" --decrypt "$LATEST" |
  docker exec -i "$RESTORE" mongorestore --archive --gzip --stopOnError \
  > "$RESTORE_LOG" 2>&1; then
  tail -25 "$RESTORE_LOG"
  false
fi
docker exec "$RESTORE" mongosh --quiet --eval '
const names=["platform_DB","classicfin_tenant_classic_db","classicfin_tenant_classic_2_db","classicfin_tenant_ghaja_db","classicfin_tenant_john_ajuot_magot_db"];
const found=new Set(db.adminCommand({listDatabases:1,nameOnly:true}).databases.map(x=>x.name));
let total=0;
for(const name of names){
  if(!found.has(name)){print("MISSING: "+name);quit(2)}
  const d=db.getSiblingDB(name);
  const collections=d.getCollectionInfos({type:"collection"});
  if(collections.length===0){print("EMPTY SCHEMA: "+name);quit(2)}
  let count=0;
  for(const c of collections)count+=d.getCollection(c.name).countDocuments({});
  print(name+" | collections="+collections.length+" | records="+count);
  total+=count;
}
if(total===0){print("FAIL: No restored records");quit(2)}
print("RESTORE VERIFIED: "+total+" records")
'
docker rm -f "$RESTORE" >/dev/null
rm -f "$RESTORE_LOG"

echo '=== 9. MIGRATE FOREX INDEXES WITH WRITES STOPPED ==='
MIGRATION_STARTED=1
for tenant in "${TENANTS[@]}"; do
  docker run --rm --network bridge \
    --memory 512m --cpus 1 --pids-limit 128 \
    --env-file /etc/classicfin/web.env \
    "$IMAGE" node scripts/forex-rate-side-migrate.js \
      "--tenant=$tenant" --apply --maintenance-confirmed --backup-verified
done

echo '=== 10. WEB CUTOVER ==='
docker rename "$APP" "$BACK"
RENAMED=1
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
  if test "$(docker inspect -f '{{.State.Health.Status}}' "$APP")" = healthy && \
     curl -fsS --max-time 4 http://127.0.0.1:3600/health/ready >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 3
done
test "$READY" = 1

# Restart unchanged workers only after the new web application is healthy.
docker start "$WORKER" "$NOTIFY" >/dev/null
for n in "$WORKER" "$NOTIFY"; do
  READY=0
  for i in $(seq 1 30); do
    if test "$(docker inspect -f '{{.State.Health.Status}}' "$n")" = healthy; then
      READY=1; break
    fi
    sleep 2
  done
  test "$READY" = 1
done
if curl -fsS --max-time 15 https://classicfinhub.com/health/ready >/dev/null; then
  echo "Public health: PASS"
else
  echo "WARNING: Public health check failed; local web is healthy. Check DNS/TLS/Caddy separately."
fi
test "$(docker inspect -f '{{.Config.Image}}' "$APP")" = "$IMAGE"
DONE=1
trap - ERR INT TERM
rm -f "$RESTORE_LOG"
echo "LIVE: $SHA"
echo "BACKUP: $LATEST"
echo "ROLLBACK IMAGE PRESERVED: $BACK"
echo 'Forex Buy/Sell indexes migrated in all four tenants.'
