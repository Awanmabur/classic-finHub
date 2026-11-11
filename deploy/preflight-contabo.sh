#!/usr/bin/env bash
# Read-only Contabo preflight for Classic FinHub. Never prints secrets.
set -Eeuo pipefail

echo '=== 1. SERVER IDENTITY ==='
hostname -s
if [[ "$(hostname -s)" != 'ct-apps-prod-01' ]]; then
  echo 'BLOCKED: this is not the expected production server.' >&2
  exit 1
fi
date -u '+UTC %Y-%m-%dT%H:%M:%SZ'
echo

echo '=== 2. DOMAIN DNS (READ-ONLY) ==='
for host in classicfinhub.com www.classicfinhub.com; do
  printf '%s: ' "$host"
  value="$(getent ahostsv4 "$host" 2>/dev/null | awk '$2=="STREAM"{print $1}' | sort -u | paste -sd, - || true)"
  printf '%s\n' "${value:-NOT_RESOLVED}"
done
if command -v dig >/dev/null; then
  printf 'Authoritative NS: '
  dig +short NS classicfinhub.com | sort | paste -sd, -
fi
echo

echo '=== 3. DOCKER, CADDY AND PORT ==='
if command -v docker >/dev/null; then
  sudo docker compose version
  sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
else
  echo 'Docker unavailable'
fi
if command -v ss >/dev/null; then
  sudo ss -lntp | grep -E '(:80 |:443 |:3500 )' || true
fi
if command -v systemctl >/dev/null; then
  printf 'Caddy systemd state: '
  systemctl is-active caddy 2>/dev/null || true
fi
if sudo test -f /etc/caddy/Caddyfile; then
  echo 'Caddyfile found; relevant site/import declarations:'
  sudo grep -nE 'classicfinhub[.]com|^[[:space:]]*import[[:space:]]' /etc/caddy/Caddyfile || true
fi
echo

echo '=== 4. SOURCE AND DEPLOY CONFIG PRESENCE ==='
if [[ -d /srv/classic/apps/classicfin/.git ]]; then
  git -C /srv/classic/apps/classicfin rev-parse --short=12 HEAD
  git -C /srv/classic/apps/classicfin status --short
  for f in deploy/compose.prod.yml deploy/release.sh deploy/Caddyfile.classicfinhub.com; do
    [[ -f "/srv/classic/apps/classicfin/$f" ]] && echo "PRESENT $f" || echo "MISSING $f"
  done
else
  echo 'EXPECTED CHECKOUT MISSING /srv/classic/apps/classicfin'
  if [[ -d /srv/classic/apps ]]; then
    find /srv/classic/apps -mindepth 1 -maxdepth 1 -type d -iname '*fin*' -print
  fi
fi
for f in /etc/classicfin/web.env /etc/classicfin/worker.env /etc/classicfin/notifications.env; do
  if sudo test -f "$f"; then
    sudo stat -c 'PRESENT %n mode=%a owner=%U' "$f"
  else
    echo "MISSING $f"
  fi
done
echo

echo '=== 5. STORAGE AND MEMORY ==='
df -h /srv/classic 2>/dev/null || df -h /
free -h || true
echo

echo '=== 6. EXISTING SERVICE AND HTTPS ==='
if command -v curl >/dev/null; then
  for target in http://127.0.0.1:3500/health/ready https://classicfinhub.com/health/ready https://classicfinhub.com/; do
    curl --silent --show-error --location --max-time 8 --output /dev/null --write-out "$target HTTP %{http_code} TLS %{ssl_verify_result}\n" "$target" || true
  done
fi

echo '=== READ-ONLY PREFLIGHT COMPLETE: REVIEW RESULTS BEFORE DEPLOY ==='
