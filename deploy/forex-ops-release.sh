#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
fail(){ echo "RELEASE BLOCKED: $*" >&2; exit 1; }
[[ "$(id -u)" = 0 ]] || fail "Use sudo"
[[ "$(hostname -s)" = ct-apps-prod-01 ]] || fail "Incorrect host"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
[[ "$SHA" = "$CLASSICFIN_EXPECTED_SHA" && "$SHA" =~ ^[a-f0-9]{40}$ ]] || fail "Incorrect commit"
[[ -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)" ]] || fail "Dirty worktree"
[[ -d "$ROOT/node_modules" ]] || fail "Missing test dependencies"
exec 9>/run/lock/classicfin-forex-ops-release.lock
flock -n 9 || fail "Another release is in progress"
IMAGE="classicfin:forex-ops-$(printf %s "$SHA" | cut -c1-12)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX="-pre-forex-$STAMP"
CANARY="classicfin-forex-canary-$$"
TESTDB="classicfin-forex-test-$$"
SAFE="/srv/classic/release-safety/classicfin/forex-ops-$STAMP"
RENAMED=""
COMPLETE=0
install -d -m 700 "$SAFE"
cleanup(){
 local rc=$?
 trap - EXIT
 set +e
 docker rm -f "$CANARY" "$TESTDB" >/dev/null 2>&1
 if [[ "$COMPLETE" = 0 && -n "$RENAMED" ]]; then
  echo "ROLLBACK: restoring old production containers" >&2
  for n in $RENAMED; do docker rm -f "$n" >/dev/null 2>&1; done
  for n in $RENAMED; do docker rename "$n$SUFFIX" "$n" || true; docker start "$n" >/dev/null 2>&1 || true; done
 fi
 echo "Protected release evidence: $SAFE"
 exit "$rc"
}
trap cleanup EXIT
echo "=== VERIFY HEALTH, BACKUP AND STANDALONE TOPOLOGY ==="
for n in classicfin-web-only classicfin-worker classicfin-notifications; do
 [[ "$(docker inspect "$n" -f '{{.State.Health.Status}}')" = healthy ]] || fail "$n unhealthy"
 docker inspect "$n" -f '{{.Image}}' > "$SAFE/$n.previous-image"
done
for f in web.env worker.env notifications.env; do [[ -s "/etc/classicfin/$f" ]] || fail "Missing $f"; done
[[ "$(systemctl show classicfin-contabo-backup.service -p Result --value)" = success ]] || fail "Production backup not confirmed"
python3 - <<'PY'
import json,subprocess
rows=json.loads(subprocess.check_output(['docker','inspect','classicfin-web-only','classicfin-worker','classicfin-notifications']))
for row in rows:
 assert row['HostConfig']['NetworkMode']=='bridge' and not row['Mounts']
 assert not (row['Config'].get('Labels') or {}).get('com.docker.compose.project')
ports=rows[0]['NetworkSettings']['Ports'].get('3000/tcp') or []
assert any(p['HostIp']=='127.0.0.1' and p['HostPort']=='3600' for p in ports)
assert rows[1]['Config']['Cmd']==['node','src/platform/workers/outbox.worker.js']
assert rows[2]['Config']['Cmd']==['node','src/tenant/workers/notification.worker.js']
print('Topology PASS')
PY
echo "=== STATIC AND UNIT TESTS ==="
docker run --rm --network none --cpus 2 --memory 3g \
 --user "$(stat -c %u "$ROOT"):$(stat -c %g "$ROOT")" \
 --mount "type=bind,src=$ROOT,dst=$ROOT,readonly" -w "$ROOT" \
 -e HOME=/tmp -e NODE_ENV=test node:22 sh -c 'npm run check && npm test' > "$SAFE/unit.log" 2>&1 || {
  grep -A 22 -m 5 '^not ok ' "$SAFE/unit.log" || true; tail -35 "$SAFE/unit.log"; fail "Unit/static test failure";
 }
grep -E '^# (tests|pass|fail)' "$SAFE/unit.log" | tail -3 || true
grep -q '^# fail 0$' "$SAFE/unit.log" || fail "Unit suite incomplete"
PORT="$(python3 - <<'PY'
import socket
with socket.socket() as s:
 s.bind(('127.0.0.1',0))
 print(s.getsockname()[1])
PY
)"
echo "=== ISOLATED FOREX AND MOBILE MONEY FINANCIAL INTEGRATIONS ==="
docker run -d --network host --name "$TESTDB" --ulimit nofile=65535:65535 --memory 2g \
 mongo:8 mongod --port "$PORT" --bind_ip 127.0.0.1 --replSet rs0 --wiredTigerCacheSizeGB 0.25 >/dev/null
ready=0
for i in $(seq 1 40); do
 if docker exec "$TESTDB" mongosh --quiet --port "$PORT" --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -qx 1; then ready=1; break; fi
 sleep 1
done
[[ "$ready" = 1 ]] || fail "Scratch MongoDB not ready"
docker exec "$TESTDB" mongosh --quiet --port "$PORT" \
 --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:$PORT'}]})" >/dev/null
ready=0
for i in $(seq 1 40); do
 if docker exec "$TESTDB" mongosh --quiet --port "$PORT" --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -qx true; then ready=1; break; fi
 sleep 1
done
[[ "$ready" = 1 ]] || fail "Scratch primary unavailable"
for f in forex-integration.js funded-operations-integration.js momo-fx-settlement-integration.js branch-multicurrency-integration.js; do
 echo "CHECK $f"
 docker run --rm --network host --cpus 2 --memory 3g \
  --user "$(stat -c %u "$ROOT"):$(stat -c %g "$ROOT")" \
  --mount "type=bind,src=$ROOT,dst=$ROOT" -w "$ROOT" \
  -e HOME=/tmp -e NODE_ENV=test -e APP_URL=http://localhost:3000 \
  -e "MONGO_PLATFORM_URI=mongodb://127.0.0.1:$PORT/classicfin_platform_db?replicaSet=rs0&directConnection=true" \
  node:22 node "scripts/$f" > "$SAFE/$f.log" 2>&1 || { tail -60 "$SAFE/$f.log"; fail "Financial integration: $f"; }
 grep 'PASS' "$SAFE/$f.log" | tail -1 || true
done
docker rm -f "$TESTDB" >/dev/null
echo "=== BUILD IMAGE AND CANARY ==="
docker buildx build --load -f "$ROOT/deploy/Dockerfile" \
 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE" "$ROOT" \
 > "$SAFE/build.log" 2>&1 || { tail -50 "$SAFE/build.log"; fail "Image build"; }
[[ "$(docker image inspect "$IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$SHA" ]] || fail "Wrong image SHA"
IMAGE_ID="$(docker image inspect "$IMAGE" -f '{{.Id}}')"
CANARY_PORT="$(python3 - <<'PY'
import socket
with socket.socket() as s:
 s.bind(('127.0.0.1',0))
 print(s.getsockname()[1])
PY
)"
docker run -d --name "$CANARY" --network bridge --env-file /etc/classicfin/web.env \
 -e CLASSICFIN_MOMO_FX_POSTING_ENABLED=true --read-only \
 --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
 --memory 512m --cpus 1 --pids-limit 128 -p "127.0.0.1:$CANARY_PORT:3000" "$IMAGE" >/dev/null
ready=0
for i in $(seq 1 30); do
 if curl -fsS --max-time 5 "http://127.0.0.1:$CANARY_PORT/health/ready" >/dev/null 2>&1; then ready=1; break; fi
 sleep 2
done
[[ "$ready" = 1 ]] || fail "Canary unavailable"
for p in / /signin /robots.txt /sitemap.xml; do
 code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
  -H 'Host: classicfinhub.com' -H 'X-Forwarded-Host: classicfinhub.com' \
  -H 'X-Forwarded-Proto: https' "http://127.0.0.1:$CANARY_PORT$p")"
 [[ "$code" = 200 ]] || fail "Canary $p HTTP $code"
done
docker rm -f "$CANARY" >/dev/null
echo "=== PRODUCTION CUTOVER WITH ROLLBACK ==="
for n in classicfin-web-only classicfin-worker classicfin-notifications; do
 docker rename "$n" "$n$SUFFIX"
 RENAMED="$RENAMED $n"
done
for n in classicfin-web-only classicfin-worker classicfin-notifications; do docker stop --time 30 "$n$SUFFIX" >/dev/null; done
docker run -d --name classicfin-web-only --restart unless-stopped --network bridge \
 --env-file /etc/classicfin/web.env -e CLASSICFIN_MOMO_FX_POSTING_ENABLED=true \
 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL \
 --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 128 -p 127.0.0.1:3600:3000 \
 --health-cmd='node -e "fetch(\"http://127.0.0.1:3000/health/ready\",{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
 --health-interval 10s --health-timeout 5s --health-retries 3 "$IMAGE" >/dev/null
docker run -d --name classicfin-worker --restart unless-stopped --network bridge \
 --env-file /etc/classicfin/worker.env -e CLASSICFIN_MOMO_FX_POSTING_ENABLED=true \
 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL \
 --security-opt no-new-privileges:true --memory 256m --cpus 0.5 --pids-limit 96 \
 --health-cmd='node scripts/worker-heartbeat.js' --health-interval 10s --health-timeout 8s --health-retries 3 \
 "$IMAGE" node src/platform/workers/outbox.worker.js >/dev/null
docker run -d --name classicfin-notifications --restart unless-stopped --network bridge \
 --env-file /etc/classicfin/notifications.env -e CLASSICFIN_MOMO_FX_POSTING_ENABLED=true \
 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL \
 --security-opt no-new-privileges:true --memory 256m --cpus 0.5 --pids-limit 96 \
 --health-cmd='node scripts/notification-worker-heartbeat.js' --health-interval 10s --health-timeout 8s --health-retries 3 \
 "$IMAGE" node src/tenant/workers/notification.worker.js >/dev/null
ready=0
for i in $(seq 1 40); do
 ok=1
 for n in classicfin-web-only classicfin-worker classicfin-notifications; do
  [[ "$(docker inspect "$n" -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" = healthy ]] || ok=0
 done
 if [[ "$ok" = 1 ]] && curl -fsS --max-time 5 http://127.0.0.1:3600/health/ready >/dev/null 2>&1; then ready=1; break; fi
 sleep 3
done
[[ "$ready" = 1 ]] || fail "Release unhealthy"
for n in classicfin-web-only classicfin-worker classicfin-notifications; do
 [[ "$(docker inspect "$n" -f '{{.Image}}')" = "$IMAGE_ID" ]] || fail "Wrong running image"
done
for p in / /signin /robots.txt /sitemap.xml; do
 [[ "$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' "https://classicfinhub.com$p")" = 200 ]] || fail "Public $p unavailable"
done
COMPLETE=1
echo "FOREX OPERATIONS RELEASE LIVE: $SHA"
echo "All three services healthy. FX posting switch enabled, provider/regulatory grants still enforced."
echo "Rollback suffix: $SUFFIX"
docker exec classicfin-web-only node scripts/forex-readiness-production.js || true
