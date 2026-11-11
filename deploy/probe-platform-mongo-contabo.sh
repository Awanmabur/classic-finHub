#!/usr/bin/env bash
# Read-only, redacted MongoDB Atlas authentication / topology / database inventory probe.
# Reuses an installed Mongo image without pulling or modifying existing Mongo containers.
set -Eeuo pipefail
umask 077
[[ "$(hostname -s)" == "ct-apps-prod-01" ]] || { echo 'Wrong host'; exit 2; }
command -v sudo >/dev/null
command -v docker >/dev/null
command -v python3 >/dev/null
command -v timeout >/dev/null
WEB_ENV=/etc/classicfin/web.env
sudo test -f "$WEB_ENV"
sudo test ! -L "$WEB_ENV"

IMG=''
for db in classic-events-mongo classic-mart-mongo classic-academy-mongo; do
  if IMG="$(sudo docker inspect --format '{{.Image}}' "$db" 2>/dev/null)"; then
    if sudo docker image inspect "$IMG" >/dev/null 2>&1; then
      echo "Client image: existing image from $db (no download)"
      break
    fi
  fi
  IMG=''
done
[[ -n "$IMG" ]] || { echo 'No existing Mongo client image. No changes made.'; exit 2; }
sudo docker run --rm --network none --entrypoint mongosh "$IMG" --version >/dev/null ||
  { echo 'Existing image lacks mongosh; no changes made.'; exit 2; }

# Root owns the temporary credential file. This avoids fs.protected_regular
# refusing privileged O_CREAT writes into a non-root-owned /tmp file.
TMP_DIR="$(sudo mktemp -d /tmp/classicfin-atlas-probe.XXXXXXXX)"
TMP="$TMP_DIR/mongo.env"
trap 'sudo rm -f -- "$TMP"; sudo rmdir -- "$TMP_DIR"' EXIT

sudo python3 - "$TMP" <<'PY'
import pathlib, re, sys
path=pathlib.Path('/etc/classicfin/web.env')
if path.is_symlink(): raise SystemExit('Unsafe config file')
items={}
for raw in path.read_text(encoding='utf-8-sig').splitlines():
    if not raw.strip() or raw.lstrip().startswith('#'): continue
    match=re.match(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$',raw)
    if not match: raise SystemExit('Environment contains an invalid line')
    key,value=match.groups()
    if key in items: raise SystemExit('Duplicate variable: '+key)
    value=value.strip()
    if len(value)>1 and value[0]==value[-1] and value[0] in ('"',"'"):
        value=value[1:-1]
    items[key]=value
uri=items.get('PLATFORM_DB_URI') or items.get('MONGO_PLATFORM_URI') or ''
if not uri.startswith(('mongodb://','mongodb+srv://')):
    raise SystemExit('Web Mongo URI missing/invalid')
if '\r' in uri or '\n' in uri:
    raise SystemExit('Unsafe Mongo URI')
# Single value only. Never transmit web mail, MFA or other secrets to test client.
target=pathlib.Path(sys.argv[1])
with target.open('x', encoding='utf-8') as output:
    output.write('MONGO_PROBE_URI='+uri+'\n')
    output.flush()
    import os
    os.fsync(output.fileno())
target.chmod(0o600)
PY

echo '=== READ-ONLY ATLAS CONNECTION TEST ==='
sudo timeout 60 docker run \
  --rm --network bridge \
  --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=32m,mode=1777 \
  --user 65534:65534 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env-file "$TMP" \
  --env HOME=/tmp \
  --entrypoint mongosh \
  "$IMG" \
  --nodb --norc --quiet --eval '
const uri=process.env.MONGO_PROBE_URI;
try {
  if (!uri) throw new Error("MissingURI");
  const match=/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?#]+)/.exec(uri);
  if (!match) throw new Error("NoDatabase");
  const selected=decodeURIComponent(match[1]);
  const conn=new Mongo(uri+(uri.includes("?")?"&":"?")+"serverSelectionTimeoutMS=7000");
  const admin=conn.getDB("admin");
  const hello=admin.runCommand({hello:1,maxTimeMS:4000});
  const auth=admin.runCommand({connectionStatus:1,showPrivileges:false});
  const isAuth=Boolean(auth.authInfo && auth.authInfo.authenticatedUsers && auth.authInfo.authenticatedUsers.length);
  print("Atlas connection: "+(isAuth?"AUTHENTICATED":"NOT AUTHENTICATED"));
  print("Replica-set primary: "+((hello.ok===1&&hello.setName&&hello.isWritablePrimary)?"PASS":"FAIL"));
  print("Configured platform DB convention: "+(selected==="classicfin_platform_db"?"MATCH":"NONSTANDARD"));
  const current=conn.getDB(selected).getCollectionNames();
  print("Configured database collections: "+current.length);
  if (selected!=="classicfin_platform_db") {
    try {
      const canonical=conn.getDB("classicfin_platform_db").getCollectionNames();
      print("Canonical database collections: "+canonical.length);
    } catch(e) {
      print("Canonical database collections: NOT ACCESSIBLE WITH WEB USER");
    }
  }
  const roles=(auth.authInfo&&auth.authInfo.authenticatedUserRoles)||[];
  const bad=["root","dbOwner","userAdmin","userAdminAnyDatabase","clusterAdmin","clusterManager","hostManager","dbAdminAnyDatabase"];
  print("Administrative service role detected: "+(roles.some(r=>bad.includes(r.role))?"YES — REVIEW REQUIRED":"NO"));
  if (!isAuth||!hello.setName||!hello.isWritablePrimary) quit(3);
} catch (e) {
  print("Atlas probe: FAILED (connection, authentication, authorization, or TLS issue; details suppressed)");
  quit(3);
}
' || { echo 'Atlas probe failed. No database writes attempted.'; exit 3; }
echo 'Read-only probe complete. No database or app containers modified.'
