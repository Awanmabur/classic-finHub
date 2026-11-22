#!/usr/bin/env bash
# Fix ONLY the ClassicFin Hub Caddy site, not the global Caddy configuration.
# Requires the live site to match the previously reviewed, deployed Caddyfile.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo "Run with sudo"; exit 1; }
test "$(hostname -s)" = ct-apps-prod-01 || { echo "Wrong host"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE=2a85b3b4f0a7b946c7fa4292ffa8cb91ec109bb3
SOURCE="$ROOT/deploy/Caddyfile.classicfinhub.com"
test -s "$SOURCE"
test -s /etc/caddy/Caddyfile
command -v caddy >/dev/null
command -v curl >/dev/null
command -v python3 >/dev/null

mapfile -t CANDIDATES < <(python3 - <<'PY'
from pathlib import Path
import re
for path in Path('/etc/caddy').rglob('*'):
    if path.is_symlink() or not path.is_file():
        continue
    try:
        if path.stat().st_size > 1048576:
            continue
        content=path.read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        continue
    if re.search(r'(?m)^classicfinhub\.com[ \t]*\{[ \t]*$',content):
        print(path)
PY
)
if (( ${#CANDIDATES[@]} != 1 )); then
    printf 'BLOCKED: expected exactly one live ClassicFin Hub site, found %s\n' "${#CANDIDATES[@]}"
    printf '%s\n' "${CANDIDATES[@]}"
    exit 1
fi
SITE="${CANDIDATES[0]}"
test -f "$SITE" && test ! -L "$SITE"

# Never overwrite a hand-customized file or a multi-site global Caddyfile.
if ! git -c safe.directory="$ROOT" -C "$ROOT" show "$BASE:deploy/Caddyfile.classicfinhub.com" | cmp -s - "$SITE"; then
    echo "BLOCKED: live site differs from approved previous template: $SITE"
    echo "No file was changed. Review this site manually; preserve other app routes."
    exit 1
fi

SAFE=/srv/classic/release-safety/classicfin/caddy
install -d -m 0700 "$SAFE"
BACKUP="$SAFE/site-$(date -u +%Y%m%dT%H%M%SZ).caddy"
install -m 0600 "$SITE" "$BACKUP"
CHANGED=0
rollback() {
    trap - ERR INT TERM
    if [ "$CHANGED" -eq 1 ]; then
        cp -- "$BACKUP" "$SITE"
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
        systemctl reload caddy || true
        echo "CADDY ROLLBACK APPLIED; inspect $BACKUP"
    fi
}
trap rollback ERR INT TERM
cp -- "$SOURCE" "$SITE"
CHANGED=1
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy

# A 96 KiB request must reach the app's auth layer, not be rejected by the edge.
PROBE="$(mktemp /tmp/classicfin-caddy-upload-probe.XXXXXX)"
trap 'rm -f "$PROBE"' EXIT
head -c 98304 /dev/zero > "$PROBE"
STATUS="$(curl -sS --max-time 20 --output /dev/null --write-out '%{http_code}' \
    --resolve classicfinhub.com:443:127.0.0.1 \
    --header 'Content-Type: image/png' \
    --header 'Accept: application/json' \
    --data-binary "@$PROBE" \
    https://classicfinhub.com/tenant/workspace/media/logo)"
if [[ "$STATUS" != 302 && "$STATUS" != 303 && "$STATUS" != 401 && "$STATUS" != 403 ]]; then
    echo "BLOCKED: unauthenticated image gateway probe returned HTTP $STATUS"
    rollback
    exit 1
fi
CHANGED=0
trap - ERR INT TERM
echo "CLASSICFIN CADDY UPLOAD GATE: VERIFIED (96 KiB request HTTP $STATUS)"
echo "Only logo/cover/gallery POST endpoints allow up to 4 MB at the gateway."
echo "All other site requests retain the previous 64 KB gateway limit."
echo "Rollback copy: $BACKUP"
