#!/usr/bin/env bash
# First-time ClassicFin Hub host preparation only. Does NOT start or expose services.
# Guardrails: preserves existing configs, checks exclusive host port, never prints keys.
set -Eeuo pipefail
umask 077

APP_DIR=/srv/classic/apps/classicfin
CONFIG_DIR=/etc/classicfin
REPO=https://github.com/Awanmabur/classic-finHub.git
DOMAIN=https://classicfinhub.com
PORT=3600

fail() { printf 'PREPARATION BLOCKED: %s\n' "$*" >&2; exit 1; }
[[ "$(hostname -s)" == "ct-apps-prod-01" ]] || fail 'Wrong host'
command -v git >/dev/null || fail 'git missing'
command -v python3 >/dev/null || fail 'python3 missing'
command -v sudo >/dev/null || fail 'sudo missing'
command -v ss >/dev/null || fail 'ss missing'
command -v docker >/dev/null || fail 'Docker missing'
if sudo ss -H -ltn "( sport = :$PORT )" | grep -q .; then
  fail "Port $PORT is occupied; choose another unused port before proceeding"
fi
if sudo grep -REq '^[[:space:]]*(classicfinhub[.]com|www[.]classicfinhub[.]com)([[:space:]{,]|$)' /srv/classic/caddy/sites --include='*.caddy' 2>/dev/null; then
  echo 'NOTICE: a Caddy site for FinHub already exists. No Caddy change will be made.'
fi
echo "Host $(hostname -s); host port $PORT is free at inspection."

if [[ -d "$APP_DIR/.git" ]]; then
  origin="$(git -C "$APP_DIR" remote get-url origin)"
  [[ "$origin" == "$REPO" || "$origin" == "git@github.com:Awanmabur/classic-finHub.git" ]] || fail "Unexpected checkout origin"
  [[ -z "$(git -C "$APP_DIR" status --porcelain)" ]] || fail 'Checkout has local edits; refusing update'
  echo 'Existing clean FinHub checkout retained. No automatic git pull.'
else
  if sudo test -e "$APP_DIR"; then
    if [[ -n "$(sudo find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then fail "Non-empty directory $APP_DIR"; fi
  else
    sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0750 "$APP_DIR"
  fi
  git clone --quiet --branch master --single-branch "$REPO" "$APP_DIR"
  echo 'Cloned Classic FinHub source.'
fi

for template in web worker notification-worker; do
  [[ -f "$APP_DIR/deploy/$template.env.example" ]] || fail "Missing template $template"
done
sudo install -d -o root -g root -m 0700 "$CONFIG_DIR"
new_web=0
new_notification=0
for spec in 'web:web' 'worker:worker' 'notification-worker:notifications'; do
  template="${spec%%:*}"
  target="${spec#*:}"
  dest="$CONFIG_DIR/$target.env"
  if sudo test -e "$dest"; then
    echo "PRESERVED: $dest (not overwritten)"
  else
    sudo install -o root -g root -m 0600 "$APP_DIR/deploy/$template.env.example" "$dest"
    sudo python3 - "$dest" <<'PY'
import pathlib, sys
path=pathlib.Path(sys.argv[1])
data=path.read_text()
data=data.replace('https://replace-with-real-domain.example','https://classicfinhub.com')
path.write_text(data)
PY
    if [[ "$target" == web ]]; then new_web=1; fi
    if [[ "$target" == notifications ]]; then new_notification=1; fi
    echo "CREATED: $dest (credentials still need configuring)"
  fi
done

# Generate keys exactly once on a fresh installation. Never replace existing
# service keys, as they protect signed sessions and encrypted MFA/SMS records.
if [[ "$new_web" == 1 && "$new_notification" == 1 ]]; then
  sudo python3 - <<'PY'
import pathlib, secrets
web=pathlib.Path('/etc/classicfin/web.env')
notify=pathlib.Path('/etc/classicfin/notifications.env')
s=secrets.token_hex(48)
m=secrets.token_hex(32)
t=secrets.token_hex(32)
def replace_blank(path, key, value):
    text=path.read_text()
    line=key+'=\n'
    if text.count(line) != 1:
        raise SystemExit('Expected exactly one empty '+key+' field; keys not modified')
    path.write_text(text.replace(line,key+'='+value+'\n',1))
replace_blank(web,'SESSION_SECRET',s)
replace_blank(web,'MFA_ENCRYPTION_KEY',m)
replace_blank(web,'TRANSFER_SMS_ENCRYPTION_KEY',t)
replace_blank(notify,'TRANSFER_SMS_ENCRYPTION_KEY',t)
PY
  echo 'Generated fresh session/MFA/transfer encryption keys privately (not displayed).'
else
  echo 'Existing config detected: no encryption keys generated or rotated.'
fi

echo
echo '=== INSTALLATION SUMMARY (NO CREDENTIAL VALUES) ==='
git -C "$APP_DIR" rev-parse --short=12 HEAD
for f in "$CONFIG_DIR/web.env" "$CONFIG_DIR/worker.env" "$CONFIG_DIR/notifications.env"; do
  sudo stat -c 'FILE %n mode=%a owner=%U' "$f"
done
echo 'Not modified: Caddy, DNS, databases, existing apps, Docker runtime.'
echo 'Not yet done: Atlas roles/URIs, mail, secure backups/restore, tested digest and release.'
