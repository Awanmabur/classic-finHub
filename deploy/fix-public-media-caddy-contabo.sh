#!/usr/bin/env bash
# ClassicFin Hub only: patch the live imported Caddy site without replacing other sites.
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo "Run with sudo"; exit 1; }
test "$(hostname -s)" = ct-apps-prod-01 || { echo "Wrong host"; exit 1; }
test -s /etc/caddy/Caddyfile
command -v caddy >/dev/null
command -v python3 >/dev/null

SITE="$(python3 - <<'PY'
from pathlib import Path
import re
main = Path('/etc/caddy/Caddyfile').read_text()
if not re.search(r'(?m)^[ \t]*import[ \t]+/srv/classic/caddy/sites/\*\.caddy[ \t]*$', main):
    raise SystemExit('BLOCKED: expected Caddy site import not found')
directory=Path('/srv/classic/caddy/sites')
matches=[]
for path in directory.glob('*.caddy'):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024*1024:
        continue
    contents=path.read_text()
    if re.search(r'(?m)^[ \t]*classicfinhub\.com[ \t]*\{[ \t]*(?:#.*)?$',contents):
        matches.append(path)
if len(matches)!=1:
    raise SystemExit('BLOCKED: expected one imported ClassicFin Hub site, found '+str(len(matches)))
print(matches[0])
PY
)"
test -n "$SITE"
echo "ClassicFin Hub live Caddy site: $SITE"

SAFE=/srv/classic/release-safety/classicfin/caddy
install -d -m 0700 "$SAFE"
BACKUP="$SAFE/site-$(date -u +%Y%m%dT%H%M%SZ).caddy"
install -m 0600 "$SITE" "$BACKUP"
STAGED="$(mktemp "$SAFE/candidate.XXXXXXXX")"
cp -- "$SITE" "$STAGED"
CHANGED=0
PROBE=''
rollback() {
    trap - ERR INT TERM EXIT
    if [ "$CHANGED" -eq 1 ]; then
        cp -- "$BACKUP" "$SITE"
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
        systemctl reload caddy || true
        echo "CADDY ROLLBACK APPLIED; inspect $BACKUP"
    fi
    if [ -n "$PROBE" ]; then rm -f -- "$PROBE"; fi
    rm -f -- "$STAGED"
}
trap rollback ERR INT TERM EXIT

python3 - "$STAGED" <<'PY'
from pathlib import Path
import re, sys, textwrap

path=Path(sys.argv[1])
original=path.read_text()
start_matches=list(re.finditer(r'(?m)^[ \t]*classicfinhub\.com[ \t]*\{[ \t]*(?:#.*)?$', original))
if len(start_matches)!=1:
    raise SystemExit('BLOCKED: site block is not unique')
start=start_matches[0].end()
start_brace=original.index('{',start_matches[0].start(),start)
def closing_brace(source, position):
    depth=0
    for i in range(position,len(source)):
        if source[i]=='{': depth+=1
        elif source[i]=='}':
            depth-=1
            if depth==0: return i+1
    raise SystemExit('BLOCKED: unbalanced Caddy block')
end=closing_brace(original,start_brace)
body=original[start:end-1]

if '@publicMediaUpload' in body:
    if not (re.search(r'handle[ \t]+@publicMediaUpload',body)
            and re.search(r'max_size[ \t]+4MB',body)
            and re.search(r'max_size[ \t]+64KB',body)):
        raise SystemExit('BLOCKED: unknown existing media upload configuration')
    print('Media upload route is already configured')
    sys.exit(0)

if re.search(r'(?m)^[ \t]*(?:handle|handle_path|route|route_group)\b',body):
    raise SystemExit('BLOCKED: customized Caddy routing needs manual review')

rb=list(re.finditer(r'(?m)^([ \t]*)request_body[ \t]*\{[ \t]*\n[ \t]*max_size[ \t]+64KB[ \t]*\n[ \t]*\}',body))
rp=list(re.finditer(r'(?m)^([ \t]*)reverse_proxy[ \t]+(?:127\.0\.0\.1|localhost):3600[ \t]*\{',body))
if len(rb)!=1 or len(rp)!=1 or len(re.findall(r'\brequest_body\b',body))!=1 or len(re.findall(r'\breverse_proxy\b',body))!=1:
    raise SystemExit('BLOCKED: expected one 64KB body rule and one ClassicFin proxy rule')
body_rule,proxy=rb[0],rp[0]
if body_rule.group(1)!=proxy.group(1):
    raise SystemExit('BLOCKED: body and proxy indentation differs')
if body_rule.end()>proxy.start() or body[body_rule.end():proxy.start()].strip():
    raise SystemExit('BLOCKED: unexpected directives between body limit and proxy')
proxy_open=body.index('{',proxy.start(),proxy.end())
proxy_end=closing_brace(body,proxy_open)
proxy_text=textwrap.dedent(body[proxy.start():proxy_end]).rstrip()
indent=body_rule.group(1)
inner=indent+'    '
def nested_proxy():
    return '\n'.join(inner+line if line.strip() else line for line in proxy_text.splitlines())
new_block='\n'.join([
    indent+'@publicMediaUpload {',
    inner+'method POST',
    inner+'path /tenant/workspace/media/logo /tenant/workspace/media/cover /tenant/workspace/media/gallery',
    indent+'}',
    indent+'handle @publicMediaUpload {',
    inner+'request_body {',
    inner+'    max_size 4MB',
    inner+'}',
    nested_proxy(),
    indent+'}',
    indent+'handle {',
    inner+'request_body {',
    inner+'    max_size 64KB',
    inner+'}',
    nested_proxy(),
    indent+'}'
])
updated=original[:start]+body[:body_rule.start()]+new_block+body[proxy_end:]+original[end-1:]
if updated==original: raise SystemExit('BLOCKED: no Caddy change')
path.write_text(updated)
print('Scoped media upload Caddy route prepared; all other directives preserved')
PY
CHANGED=1
cp -- "$STAGED" "$SITE"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy

# The request is intentionally unauthenticated and uses localhost only.
# A 96 KiB payload must reach application authentication rather than fail at Caddy.
PROBE="$(mktemp /tmp/classicfin-caddy-upload-probe.XXXXXX)"
head -c 98304 /dev/zero > "$PROBE"
STATUS="$(curl -skS --max-time 20 --output /dev/null --write-out '%{http_code}' \
    --resolve classicfinhub.com:443:127.0.0.1 \
    --header 'Content-Type: image/png' \
    --header 'Accept: application/json' \
    --data-binary "@$PROBE" \
    https://classicfinhub.com/tenant/workspace/media/logo)"
if [[ "$STATUS" != 302 && "$STATUS" != 303 && "$STATUS" != 401 && "$STATUS" != 403 ]]; then
    echo "BLOCKED: media gateway probe HTTP $STATUS, expected auth rejection"
    exit 1
fi
CHANGED=0
trap - ERR INT TERM EXIT
rm -f -- "$PROBE" "$STAGED"
echo "CLASSICFIN CADDY UPLOAD GATE: VERIFIED (96 KiB request HTTP $STATUS)"
echo "Only the three media POSTs allow 4MB at Caddy; other routes retain 64KB."
echo "Rollback copy: $BACKUP"
