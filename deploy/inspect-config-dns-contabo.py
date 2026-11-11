#!/usr/bin/env python3
"""Read-only ClassicFin Hub production configuration and DNS gate.

Never displays URI hosts, usernames, passwords, keys, or environment values.
This checks syntax/policy and DNS only; no MongoDB auth connection is performed.
"""
import ipaddress
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import urllib.parse

ROOT = pathlib.Path('/etc/classicfin')
FILES = {k: ROOT / (k + '.env') for k in ('setup', 'web', 'worker', 'notifications')}
ENTRY = re.compile(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$')
EXPECTED_DB = 'classicfin_platform_db'

def clean(raw):
    v = raw.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        v = v[1:-1]
    return v

def filled(raw):
    v = clean(raw)
    return bool(v) and not re.search(r'change[-_]?me|replace[-_]|your[-_]|placeholder|<[^>]+>',v,re.I)

def parse(name):
    path = FILES[name]
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f'{path.name}: missing or unsafe')
    result = {}
    for number, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m = ENTRY.match(line)
        if not m:
            raise RuntimeError(f'{path.name}: invalid KEY=VALUE at line {number}')
        k, raw = m.groups()
        if k in result:
            raise RuntimeError(f'{path.name}: repeated {k}')
        result[k] = clean(raw)
    return result

def mongo_status(raw, *, base=False):
    if not filled(raw):
        return None, ['NOT CONFIGURED']
    problems=[]
    if raw.startswith('mongodb+srv://'):
        kind='SRV (TLS default)'
    elif raw.startswith('mongodb://'):
        kind='standard'
    else:
        return None, ['INVALID URI SCHEME']
    try:
        parts=urllib.parse.urlsplit(raw)
        if not parts.hostname or parts.fragment:
            problems.append('INVALID AUTHORITY / FRAGMENT')
        db=urllib.parse.unquote(parts.path.lstrip('/'))
        if base:
            if db:
                problems.append('BASE URI MUST NOT NAME DATABASE')
        elif db != EXPECTED_DB:
            problems.append('NONSTANDARD PLATFORM DB NAME — RUNTIME MAY ACCEPT; REVIEW BACKUP/RESTORE ASSUMPTIONS')
        user=parts.username
        password=parts.password
        if not user or not password:
            problems.append('MISSING DB USERNAME OR PASSWORD')
        if parts.username and (' ' in parts.username or '@' in parts.username):
            problems.append('POSSIBLE CREDENTIAL ENCODING ISSUE')
        query=urllib.parse.parse_qs(parts.query,keep_blank_values=True)
        low={k.lower():v[-1].lower() for k,v in query.items()}
        if low.get('tls')=='false' or low.get('ssl')=='false' or low.get('tlsinsecure')=='true' or low.get('tlsallowinvalidcertificates')=='true':
            problems.append('UNSAFE TLS OVERRIDE')
        if kind=='standard':
            if low.get('tls')!='true' and low.get('ssl')!='true':
                problems.append('EXPLICIT TLS REQUIRED FOR STANDARD URI')
            if not low.get('replicaset'):
                problems.append('REPLICA SET OPTION MISSING')
        if not parts.hostname:
            problems.append('NO HOST')
        if parts.hostname:
            try:
                if ipaddress.ip_address(parts.hostname).is_loopback:
                    problems.append('LOOPBACK URI WILL NOT REACH HOST DB FROM BRIDGE CONTAINER')
            except ValueError:
                if parts.hostname.lower() in ('localhost','host.docker.internal'):
                    problems.append('LOCAL HOSTNAME REQUIRES REVIEW')
        return {'kind':kind, 'hostname':parts.hostname, 'db':db,
                'user':parts.username, 'password':parts.password,
                'authsource':low.get('authsource'), 'query':low}, problems
    except Exception:
        return None, ['MALFORMED URI']

def print_status(label, raw, *, base=False):
    entry, problems=mongo_status(raw,base=base)
    print(f'{label}:', (' | '.join(problems) if problems else 'SYNTAX/POLICY PASS — LIVE AUTH NOT TESTED'))
    return entry

def dns(host, kind):
    if not shutil.which('dig'):
        print(f'{host} {kind}: DIG NOT INSTALLED')
        return
    try:
        r=subprocess.run(['dig','+short',kind,host],capture_output=True,text=True,timeout=7,check=False)
        values=[l.strip() for l in r.stdout.splitlines() if l.strip()]
        print(f'{host} {kind}:', ('RECORDS PRESENT ('+str(len(values))+')' if values else 'NO RECORDS'))
    except (OSError, subprocess.TimeoutExpired):
        print(f'{host} {kind}: DNS LOOKUP FAILED')

def main():
    if os.geteuid()!=0:
        raise RuntimeError('Use sudo')
    c={name:parse(name) for name in FILES}
    s,w,o,n=(c[k] for k in ('setup','web','worker','notifications'))
    print('=== CLASSIC FINHUB READ-ONLY DEPLOYMENT GATE ===')
    platform=print_status('WEB PLATFORM_DB_URI', w.get('PLATFORM_DB_URI') or w.get('MONGO_PLATFORM_URI',''))
    base=print_status('WEB MONGO_URI_BASE', w.get('MONGO_URI_BASE',''),base=True) if filled(w.get('MONGO_URI_BASE','')) else None
    worker=print_status('OUTBOX MONGO_WORKER_URI',o.get('MONGO_WORKER_URI',''))
    notify=print_status('NOTIFICATION MONGO_NOTIFICATION_WORKER_URI',n.get('MONGO_NOTIFICATION_WORKER_URI',''))
    if base and platform:
        same=(base['hostname']==platform['hostname'] and base['user']==platform['user'] and base['password']==platform['password']
              and base['kind']==platform['kind'] and base['authsource']==platform['authsource'])
        print('WEB TENANT BASE CONSISTENCY:', 'BASIC MATCH (FULL DRIVER VALIDATION STILL NEEDED)' if same else 'MISMATCH — REVIEW BEFORE DEPLOY')
    if all((platform,worker,notify)):
        same_server=all(x['hostname']==platform['hostname'] and x['db']==platform['db'] for x in (worker,notify))
        principals=len({x['user'] for x in (platform,worker,notify)})==3
        print('SERVICE URI SAME SERVER/DB:', 'BASIC MATCH' if same_server else 'MISMATCH')
        print('THREE DISTINCT SERVICE USERS:', 'YES' if principals else 'NO')
    print('RESEND_API_KEY WEB:', 'SET' if filled(w.get('RESEND_API_KEY','')) else 'MISSING')
    print('MAIL_FROM WEB:', 'SET' if filled(w.get('MAIL_FROM','')) else 'MISSING')
    print('MFA:', 'DISABLED BY OPERATOR' if w.get('MFA_ENABLED')=='false' else 'REVIEW ACTUAL WEB SETTING')
    print('REAL MONEY:', 'DISABLED' if w.get('REAL_MONEY_ENABLED')=='false' else 'UNSAFE SETTING — BLOCK RELEASE')
    print('SOURCE STAGING TYPO FILE:', 'EXISTS' if (ROOT/'setup.env.').exists() else 'ABSENT')
    print('--- DNS ---')
    dns('classicfinhub.com','A')
    dns('www.classicfinhub.com','CNAME')
    if platform and platform['kind'].startswith('SRV') and platform['hostname']:
        # Exposes only count of SRV results, never Mongo cluster hostname.
        host='_mongodb._tcp.'+platform['hostname']
        try:
            res=subprocess.run(['dig','+short','SRV',host],capture_output=True,text=True,timeout=7,check=False)
            print('MONGODB SRV DNS:', 'RECORDS PRESENT' if res.stdout.strip() else 'NO RECORDS')
        except (OSError, subprocess.TimeoutExpired):
            print('MONGODB SRV DNS: LOOKUP FAILED')
    print('--- DOCKER IMAGE / CI ---')
    print('CI image digest not established by this check. Do not deploy mutable image tags.')
    print('NO changes made. DB connection, authentication and permissions NOT tested.')

if __name__=='__main__':
    try:main()
    except (OSError,RuntimeError) as exc:
        print('PRECHECK BLOCKED:',exc,file=sys.stderr)
        sys.exit(2)
