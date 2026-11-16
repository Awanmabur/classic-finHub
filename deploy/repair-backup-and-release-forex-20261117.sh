#!/usr/bin/env bash
# One-time production-safe repair of the temporary restore's memory cap,
# followed by the already reviewed Forex release only after fresh backup PASS.
set -Eeuo pipefail
umask 077

test "$(hostname -s)" = ct-apps-prod-01
test "$(id -u)" -eq 0

PROGRAM=/usr/local/sbin/classicfin-contabo-backup
SERVICE=classicfin-contabo-backup.service
REPO=/srv/classic/apps/classicfin
BRANCH=ops/forex-live-release-20261117
RELEASE_SHA=a6cfa3fc341a899976ddd37a96c2d276080998f5
SCRIPT_BLOB=4a4e5e9217a4f0e5ef9d8c37b67174f178fb1347
RELFILE=deploy/forex-one-shot-release-20261117.sh

BACK=''
ROLLBACK_PATCH=0
DEPLOY_STARTED=0
RELEASE_FILE=''
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if (( ROLLBACK_PATCH == 1 )) && test -n "$BACK"; then
    cp -p "$BACK" "$PROGRAM"
    echo 'Backup program restored to its original version after a failed check.'
  fi
  if test -n "$RELEASE_FILE"; then rm -f "$RELEASE_FILE"; fi
  if (( status != 0 )); then
    if (( DEPLOY_STARTED == 1 )); then
      echo 'The guarded release failed. Check its last stage and do NOT manually restart old Forex code if migration began.'
    else
      echo 'No Forex migration or application cutover was attempted.'
    fi
    echo "STOPPED (exit $status)"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

exec 9>/run/lock/classicfin-forex-repair.lock
flock -n 9

for name in classicfin-web-only classicfin-worker classicfin-notifications; do
  test "$(docker inspect "$name" -f '{{.State.Health.Status}}')" = healthy
done
test -s "$PROGRAM"
test -d /var/backups/classicfin
test -s /etc/classicfin/backup-key
FREE_MB="$(awk '/MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
echo "Available host RAM: ${FREE_MB} MB"
(( FREE_MB >= 2600 ))

echo '=== 1. REPAIR ONLY THE BACKUP RESTORE CONTAINER LIMIT ==='
python3 - "$PROGRAM" <<'PY'
from pathlib import Path
import os,stat,sys,tempfile

path=Path(sys.argv[1])
original=path.read_bytes()
old=b'--memory 768m'
new=b'--memory 1536m'
tmpfs=b'--tmpfs /data/db:rw,nosuid,size=2048m'
if original.count(tmpfs)!=1:
    raise SystemExit('BLOCKED: unexpected restore data-volume configuration')
if not original.startswith(b'#!'):
    raise SystemExit('BLOCKED: unexpected backup executable')
if original.count(old)==1 and original.count(new)==0:
    print('Needs patch: yes')
elif original.count(old)==0 and original.count(new)==1:
    print('Needs patch: no (already 1536 MB)')
else:
    raise SystemExit('BLOCKED: unknown memory settings')
PY

# A backup copy is retained even after a successful repair.
BACK="${PROGRAM}.before-forex-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$PROGRAM" "$BACK"
ROLLBACK_PATCH=1
python3 - "$PROGRAM" <<'PY'
from pathlib import Path
import os,stat,sys,tempfile
file=Path(sys.argv[1])
raw=file.read_bytes()
old=b'--memory 768m'
new=b'--memory 1536m'
if raw.count(old)==0 and raw.count(new)==1:
    print('Restore container already has 1536 MB limit')
    sys.exit(0)
if raw.count(old)!=1 or raw.count(new)!=0:
    raise SystemExit('Memory setting changed concurrently; blocked')
fd,name=tempfile.mkstemp(prefix='.classicfin-backup-',dir=str(file.parent))
try:
    with os.fdopen(fd,'wb') as f:
        f.write(raw.replace(old,new,1))
        f.flush()
        os.fsync(f.fileno())
    meta=file.stat()
    os.chmod(name,stat.S_IMODE(meta.st_mode))
    os.chown(name,meta.st_uid,meta.st_gid)
    os.replace(name,file)
except BaseException:
    try:os.unlink(name)
    except OSError:pass
    raise
print('Temporary restore memory raised from 768 MB to 1536 MB')
PY
bash -n "$PROGRAM"

echo '=== 2. VERIFY A NEW FULL BACKUP WITH INSTALLED RESTORE SERVICE ==='
PREV="$(ls -1t /var/backups/classicfin/classicfin-full-*.gpg | head -1)"
systemctl start "$SERVICE"
test "$(systemctl show "$SERVICE" -p Result --value)" = success
LATEST="$(ls -1t /var/backups/classicfin/classicfin-full-*.gpg | head -1)"
test "$LATEST" != "$PREV"
(cd /var/backups/classicfin && sha256sum --check "$(basename "$LATEST").sha256")
echo "Fresh encrypted backup service: PASS ($(basename "$LATEST"))"
ROLLBACK_PATCH=0

echo '=== 3. VERIFY PINNED FOREX RELEASE SCRIPT ==='
runuser -u classicdeploy -- git -C "$REPO" fetch --no-tags origin \
  "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
test "$(runuser -u classicdeploy -- git -C "$REPO" rev-parse "origin/$BRANCH")" = "$RELEASE_SHA"
RELEASE_FILE="$(mktemp /tmp/classicfin-forex-XXXXXX.sh)"
runuser -u classicdeploy -- git -C "$REPO" show "$RELEASE_SHA:$RELFILE" >"$RELEASE_FILE"
test "$(git hash-object "$RELEASE_FILE")" = "$SCRIPT_BLOB"
bash -n "$RELEASE_FILE"

echo '=== 4. RUN GUARDED FOREX RELEASE ==='
DEPLOY_STARTED=1
bash "$RELEASE_FILE"
echo 'BACKUP REPAIR AND FOREX RELEASE COMPLETE'
