#!/usr/bin/env bash
set -Eeuo pipefail
# Deploy one tested image digest to web and both workers; revert all if readiness fails.
# Run only after verified staging and tested database-backward-compatible migrations.
COMPOSE_FILE="${CLASSICFIN_COMPOSE_FILE:-/srv/classic/apps/classicfin/deploy/compose.prod.yml}"
STATE_DIR="${CLASSICFIN_STATE_DIR:-/srv/classic/compose/classicfin}"
STATE="$STATE_DIR/current-image"
IMAGE="${CLASSICFIN_RELEASE_IMAGE:-}"
HOST_PORT="${CLASSICFIN_HOST_PORT:-3600}"

fail() { printf 'RELEASE BLOCKED: %s\n' "$*" >&2; exit 1; }
[[ "$IMAGE" =~ ^[a-zA-Z0-9._/:@-]+@sha256:[a-f0-9]{64}$ ]] || fail 'CLASSICFIN_RELEASE_IMAGE must be an immutable registry image digest'
[[ "$HOST_PORT" =~ ^[0-9]{2,5}$ ]] || fail 'Invalid host port'
[[ -f "$COMPOSE_FILE" ]] || fail 'Compose file missing'
[[ -f "${CLASSICFIN_ENV_FILE:-}" ]] || fail 'Web secrets env file missing'
[[ -f "${CLASSICFIN_WORKER_ENV_FILE:-}" ]] || fail 'Worker secrets env file missing'
[[ -f "${CLASSICFIN_NOTIFICATION_ENV_FILE:-}" ]] || fail 'Notification worker secrets env file missing'
command -v docker >/dev/null || fail 'Docker not installed'
command -v curl >/dev/null || fail 'curl required for health check'
command -v flock >/dev/null || fail 'flock required to serialize deployments'
[[ "$STATE_DIR" = /* ]] || fail 'State directory must be absolute'
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"$STATE_DIR/release.lock"
flock -n 9 || fail 'Another release is already running'

previous=""
if [[ -f "$STATE" ]]; then
  previous="$(cat "$STATE")"
  [[ "$previous" =~ ^[a-zA-Z0-9._/:@-]+@sha256:[a-f0-9]{64}$ ]] || fail 'Invalid saved image reference'
elif [[ "${CLASSICFIN_INITIAL_DEPLOY:-}" != "I_ACCEPT_NO_AUTOMATIC_ROLLBACK" ]]; then
  fail 'No saved previous image: first deployment needs CLASSICFIN_INITIAL_DEPLOY=I_ACCEPT_NO_AUTOMATIC_ROLLBACK'
fi

BACKUP_COMPOSE="${CLASSICFIN_TENANT_BACKUP_COMPOSE_FILE:-}"
if [[ -n "$BACKUP_COMPOSE" ]]; then
  [[ -f "$BACKUP_COMPOSE" ]] || fail 'Tenant backup Compose overlay missing'
  [[ -f "${CLASSICFIN_TENANT_BACKUP_ENV_FILE:-}" ]] || fail 'Tenant backup worker env file missing'
  [[ -d "${CLASSICFIN_TENANT_BACKUP_DIR:-}" ]] || fail 'Persistent tenant backup directory missing'
fi
compose() { local files=(-f "$COMPOSE_FILE"); if [[ -n "$BACKUP_COMPOSE" ]]; then files+=(-f "$BACKUP_COMPOSE"); fi; docker compose --project-name classicfin "${files[@]}" "$@"; }
backup_health() { [[ -z "$BACKUP_COMPOSE" ]] || compose exec -T classicfin-tenant-backups node scripts/tenant-backup-heartbeat.js >/dev/null 2>&1; }
health() {
  for _ in {1..20}; do
    if curl --silent --show-error --fail --max-time 4 "http://127.0.0.1:${HOST_PORT}/health/ready" >/dev/null 2>&1 &&
       compose exec -T classicfin-worker node scripts/worker-heartbeat.js >/dev/null 2>&1 &&
       compose exec -T classicfin-notifications node scripts/notification-worker-heartbeat.js >/dev/null 2>&1 && backup_health; then
      return 0
    fi
    sleep 3
  done
  return 1
}
rollback() {
  trap - ERR
  if [[ -n "$previous" ]]; then
    echo 'Release failed: restoring previous immutable image for web and both workers.' >&2
    export CLASSICFIN_IMAGE="$previous"
    compose up -d --no-build --remove-orphans || true
    if health; then echo 'Rollback health PASS' >&2; else echo 'CRITICAL: rollback health FAILED; manual incident response required' >&2; fi
  else
    echo 'CRITICAL: initial deployment failed and no previous image exists' >&2
  fi
  exit 1
}
export CLASSICFIN_IMAGE="$IMAGE"
# Validate fully interpolated configuration before any deployment change.
compose config --quiet
echo 'Pulling verified immutable image (web and both workers).'
docker pull "$IMAGE"
# Validation or pull failures leave the running deployment untouched.
trap rollback ERR
compose up -d --no-build --remove-orphans
health # ERR trap rolls back if the release never becomes ready
printf '%s\n' "$IMAGE" >"$STATE.next"
chmod 600 "$STATE.next"
mv -f "$STATE.next" "$STATE"
trap - ERR
echo 'RELEASE HEALTH PASS: immutable image activated for web and both workers.'
