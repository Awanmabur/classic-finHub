#!/usr/bin/env python3
"""Read-only ClassicFin Hub external readiness check.

No email is sent. No configuration, proxy, DNS, database or Docker changes.
Secret values, API response bodies, URLs containing credentials, and email
addresses are never printed. Requires root to read /etc/classicfin/web.env.
"""
import email.utils
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

ROOT=pathlib.Path('/etc/classicfin')
FILE=ROOT/'web.env'
DOMAIN='classicfinhub.com'
ITEM=re.compile(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$')

def parse():
    if FILE.is_symlink() or not FILE.is_file():
        raise RuntimeError('Protected web configuration not found')
    items={}
    for n,line in enumerate(FILE.read_text(encoding='utf-8-sig').splitlines(),1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m=ITEM.match(line)
        if not m:
            raise RuntimeError('Malformed web environment entry at line '+str(n))
        k,value=m.groups()
        if k in items:
            raise RuntimeError('Repeated web environment name: '+k)
        value=value.strip()
        if len(value)>=2 and value[0]==value[-1] and value[0] in ("'",'"'):
            value=value[1:-1]
        items[k]=value
    return items

def dns(name, kind):
    if not shutil.which('dig'):
        return 'UNAVAILABLE (dig not installed)'
    try:
        r=subprocess.run(['dig','+short',kind,name,'@1.1.1.1'],capture_output=True,text=True,timeout=10,check=False)
        if r.returncode:
            return 'QUERY FAILED'
        lines=[line.strip() for line in r.stdout.splitlines() if line.strip()]
        return 'PRESENT ('+str(len(lines))+' record(s))' if lines else 'NO RECORDS'
    except (OSError,subprocess.TimeoutExpired):
        return 'QUERY FAILED'

def http_status(url):
    if not shutil.which('curl'):return 'CURL NOT FOUND'
    try:
        r=subprocess.run(['curl','--silent','--location','--max-time','12','--output','/dev/null','--write-out','%{http_code}:%{ssl_verify_result}',url],text=True,capture_output=True,timeout=16,check=False)
        parts=r.stdout.strip().split(':')
        if r.returncode:
            return 'FAILED (curl exit '+str(r.returncode)+')'
        if len(parts)!=2:return 'UNEXPECTED PROBE RESPONSE'
        return 'HTTP '+parts[0]+', TLS '+('OK' if parts[1]=='0' else 'NOT VERIFIED')
    except (OSError,subprocess.TimeoutExpired):
        return 'FAILED (timeout/tool error)'

def resend_status(token):
    if not token or not token.strip() or token.lower().startswith(('change-me','replace-me')):
        print('Resend API token: MISSING OR PLACEHOLDER')
        return
    print('Resend API token: PRESENT (validity checked below)')
    request=urllib.request.Request('https://api.resend.com/domains',
         headers={'Authorization':'Bearer '+token.strip(),'Accept':'application/json','User-Agent':'ClassicFin/1.0'},
         method='GET')
    try:
        with urllib.request.urlopen(request,timeout=12) as r:
            data=json.loads(r.read(512*1024))
        domains=data.get('data',[]) if isinstance(data,dict) else []
        matched=next((row for row in domains if isinstance(row,dict) and row.get('name','').lower()==DOMAIN),None)
        if matched is None:
            print('Resend sending domain: NOT FOUND IN THIS API KEY ACCOUNT')
            return
        status=str(matched.get('status','unknown'))
        if status not in ('verified','partially_verified','not_started','pending','failed','temporary_failure'):
            status='OTHER / CHECK DASHBOARD'
        sending=matched.get('capabilities',{}).get('sending') if isinstance(matched.get('capabilities'),dict) else None
        print('Resend domain status: '+status)
        print('Resend sending capability: '+(sending if sending in ('enabled','disabled') else 'NOT REPORTED'))
        if status not in ('verified','partially_verified') or sending!='enabled':
            print('Resend delivery status: NOT YET CONFIRMED; REVIEW DOMAIN DNS IN DASHBOARD')
        else:
            print('Resend delivery status: DOMAIN REPORTED READY; NO EMAIL SENT')
    except urllib.error.HTTPError as e:
        if e.code==403:
            print('Resend domain API: PERMISSION RESTRICTED (normal for some sending-only keys); check Domains dashboard')
        elif e.code==401:
            print('Resend domain API: UNAUTHORIZED; check token and account')
        else:
            print('Resend domain API: HTTP '+str(e.code)+'; not verified')
    except (urllib.error.URLError,TimeoutError,ValueError,TypeError) as exc:
        print('Resend domain API: NOT VERIFIED ('+type(exc).__name__+')')
    except Exception:
        print('Resend domain API: UNEXPECTED FAILURE (details suppressed)')

def caddy():
    print('=== CADDY STATUS (READ-ONLY) ===')
    if shutil.which('systemctl'):
        r=subprocess.run(['systemctl','is-active','caddy'],capture_output=True,text=True,timeout=8,check=False)
        print('Caddy service:',r.stdout.strip() if r.stdout.strip() in ('active','inactive','failed') else 'UNKNOWN')
    path=pathlib.Path('/srv/classic/caddy/sites')
    if path.is_dir():
        found=[]
        for entry in path.glob('*.caddy'):
            try:
                if not entry.is_symlink() and DOMAIN in entry.read_text(errors='ignore'):
                    found.append(entry.name)
            except OSError:
                continue
        print('FinHub Caddy site file:', ', '.join(found) if found else 'NOT INSTALLED')
    else:
        print('Caddy site directory: NOT FOUND')
    print('Caddy HTTPS routing: MUST BE TESTED AFTER WEB READY')

def main():
    if os.geteuid()!=0:
        raise RuntimeError('Use sudo to read root-owned web configuration')
    values=parse()
    print('=== CLASSICFIN EXTERNAL READINESS (NO WRITES, NO SECRETS) ===')
    print('MFA policy:', 'DISABLED (OPERATOR REQUEST)' if values.get('MFA_ENABLED')=='false' else 'REVIEW')
    print('Real-money execution:', 'OFF' if values.get('REAL_MONEY_ENABLED')=='false' else 'UNSAFE — BLOCK PUBLIC DEPLOY')
    _, address=email.utils.parseaddr(values.get('MAIL_FROM',''))
    address=address.lower()
    print('MAIL_FROM:', 'DOMAIN MATCH' if address.endswith('@'+DOMAIN) else 'MISSING OR DOMAIN MISMATCH')
    print('=== RESEND READ-ONLY ACCOUNT CHECK ===')
    resend_status(values.get('RESEND_API_KEY',''))
    print('=== PUBLIC DNS AND HTTPS ===')
    for host in (DOMAIN,'www.'+DOMAIN):
        for kind in ('A','CNAME'):
            print(host,kind+':',dns(host,kind))
    for label,kind,host in [('DMARC','TXT','_dmarc.'+DOMAIN),('DKIM (common selector)','TXT','resend._domainkey.'+DOMAIN)]:
        print(label+':',dns(host,kind))
    print('Public apex HTTPS:',http_status('https://'+DOMAIN+'/'))
    print('Public www HTTPS:',http_status('https://www.'+DOMAIN+'/'))
    caddy()
    print('=== MANUAL EVIDENCE STILL REQUIRED ===')
    print('Confirm Cloudflare A record origin points to the intended Contabo IPv4, and SSL/TLS uses Full (strict).')
    print('Confirm exact Resend DNS records and deliver a real test to an authorized inbox before enabling recovery.')
    print('Confirm Atlas snapshot/PITR covers platform_DB AND all classicfin_tenant_* databases; test isolated restore.')
    print('Full release still needs distinct worker database URIs and a CI-verified immutable image digest.')
    print('No external email sent. No DNS, DB, Docker, Caddy or environment files changed.')

if __name__=='__main__':
    try:
        main()
    except (OSError,RuntimeError) as exc:
        print('EXTERNAL PREFLIGHT BLOCKED:',exc, file=sys.stderr)
        sys.exit(2)
