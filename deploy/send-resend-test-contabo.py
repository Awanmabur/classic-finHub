#!/usr/bin/env python3
"""Send exactly one controlled Resend test email without revealing credentials.

Run under sudo with CFH_TEST_TO and CFH_CONFIRM_SEND=SEND_ONE_TEST_EMAIL.
A provider acceptance means queued/accepted, not delivered to the recipient.
"""
from __future__ import annotations
import email.utils
import json
import os
import pathlib
import re
import stat
import sys
import urllib.error
import urllib.request

WEB=pathlib.Path('/etc/classicfin/web.env')
DOMAIN='classicfinhub.com'
PAIR=re.compile(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$')
EMAIL=re.compile(r'^[^@\s<>]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')

def parse_env():
    st=WEB.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or (st.st_mode & 0o077)!=0:
        raise RuntimeError('Web environment must be root-owned, private and a regular file')
    values={}
    for line in WEB.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m=PAIR.match(line)
        if not m:raise RuntimeError('Malformed web env line; review privately')
        key,v=m.groups()
        if key in values:raise RuntimeError('Duplicate environment variable: '+key)
        v=v.strip()
        if len(v)>1 and v[0]==v[-1] and v[0] in ("'",'"'):v=v[1:-1]
        values[key]=v
    return values

def main():
    if os.geteuid()!=0:raise RuntimeError('Run under sudo')
    if os.environ.get('CFH_CONFIRM_SEND')!='SEND_ONE_TEST_EMAIL':
        raise RuntimeError('Missing explicit one-email confirmation')
    target=os.environ.get('CFH_TEST_TO','').strip()
    if len(target)>254 or not EMAIL.fullmatch(target) or '\n' in target or '\r' in target:
        raise RuntimeError('Supply the address of an inbox you control in CFH_TEST_TO')
    conf=parse_env()
    key=conf.get('RESEND_API_KEY','').strip()
    sender=conf.get('MAIL_FROM','').strip()
    parsed=email.utils.parseaddr(sender)[1].lower()
    if not key.startswith('re_') or len(key)<10:
        raise RuntimeError('Resend API key missing or improperly formatted')
    if not parsed.endswith('@'+DOMAIN) or not EMAIL.fullmatch(parsed):
        raise RuntimeError('MAIL_FROM must use a validated @'+DOMAIN+' sender')
    if conf.get('APP_URL','').rstrip('/')!='https://'+DOMAIN:
        raise RuntimeError('APP_URL is not the intended canonical domain')
    body={
        'from':sender,
        'to':[target],
        'subject':'ClassicFin Hub - one-time email delivery test',
        'text':'ClassicFin Hub deployment email test. Please confirm you received this in the intended inbox. This message does not activate financial operations.'
    }
    request=urllib.request.Request(
        'https://api.resend.com/emails',
        data=json.dumps(body,ensure_ascii=True).encode('utf-8'),
        headers={
            'Authorization':'Bearer '+key,
            'Content-Type':'application/json',
            'Accept':'application/json',
            'User-Agent':'ClassicFin-Deploy-Mail-Check/1.0'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(request,timeout=20) as response:
            status=response.status
            data=json.loads(response.read(16384))
        if status not in (200,201,202) or not isinstance(data,dict) or not data.get('id'):
            raise RuntimeError('Unexpected Resend acceptance response')
        print('Resend test request: ACCEPTED BY PROVIDER (HTTP '+str(status)+')')
        print('Delivery confirmation: NOT YET VERIFIED')
        print('Check the controlled recipient inbox, including Spam, and Resend Logs.')
    except urllib.error.HTTPError as e:
        try:
            data=json.loads(e.read(4096))
            reason=data.get('name','unknown') if isinstance(data,dict) else 'unknown'
        except (ValueError,TypeError,OSError):
            reason='unknown'
        if reason not in {'restricted_api_key','invalid_api_key','missing_api_key','validation_error',
                           'forbidden','not_found','unprocessable_entity','rate_limit_exceeded',
                           'invalid_from_address','invalid_request'}:
            reason='redacted'
        print('Resend test request: REJECTED (HTTP '+str(e.code)+', category '+reason+')')
        print('Review Resend sending-domain verification, API key restrictions and sender address.')
        sys.exit(3)
    except (urllib.error.URLError,TimeoutError):
        print('Resend test request: NETWORK ERROR; send outcome uncertain; inspect provider logs before retrying.')
        sys.exit(4)

if __name__=='__main__':
    try:main()
    except (RuntimeError,OSError,ValueError) as error:
        print('Resend test BLOCKED:',str(error),file=sys.stderr)
        sys.exit(2)
