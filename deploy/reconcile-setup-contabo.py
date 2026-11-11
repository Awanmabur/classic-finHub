#!/usr/bin/env python3
"""Safely reconcile operator setup.env into ClassicFin's private service configs.

Preserves bootstrap keys, generates missing app-owned secrets, and prints only
names/status. Does not connect to any provider or start containers.
"""
import os, re, secrets, pathlib, shutil, datetime, stat, sys
P = pathlib.Path('/etc/classicfin')
files = {n: P / f'{n}.env' for n in ('setup', 'web', 'worker', 'notifications')}
pattern = re.compile(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$')

def parse(path):
    data, lines = {}, path.read_text(encoding='utf-8-sig').splitlines()
    for ix, line in enumerate(lines, 1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m = pattern.match(line)
        if not m:
            raise ValueError(f'{path.name} line {ix}: expected single-line KEY=VALUE')
        k, v = m.groups()
        if k in data:
            raise ValueError(f'{path.name} contains duplicate variable {k}')
        data[k] = v
    return data, lines

def val(s):
    s = s.strip()
    return s[1:-1] if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'") else s

def provided(s):
    s = val(s).strip()
    return bool(s) and not re.search(r'change[-_]?me|replace[-_]|your[-_]|placeholder', s, re.I)

def rewrite(lines, changes):
    out, used = [], set()
    for line in lines:
        m = pattern.match(line)
        if m and m.group(1) in changes:
            k = m.group(1)
            out.append(k + '=' + changes[k])
            used.add(k)
        else:
            out.append(line)
    out.extend(f'{k}={v}' for k, v in changes.items() if k not in used)
    return '\n'.join(out) + '\n'

def run():
    if os.geteuid() != 0:
        raise ValueError('Run with sudo')
    os.umask(0o077)
    if not P.is_dir() or P.is_symlink():
        raise ValueError('Invalid configuration directory')
    for f in files.values():
        if f.is_symlink() or not f.is_file() or f.stat().st_uid != 0:
            raise ValueError(f'Missing or unsafe root-owned file: {f}')
        os.chmod(f, 0o600)
    D, L = {}, {}
    for n, f in files.items():
        D[n], L[n] = parse(f)
    stage, web, notifications = D['setup'], D['web'], D['notifications']
    keys = {}
    reconciled_conflicts = []
    for k, length in {'SESSION_SECRET': 48,
                      'MFA_ENCRYPTION_KEY': 32,
                      'TRANSFER_SMS_ENCRYPTION_KEY': 32}.items():
        live = [val(web.get(k, ''))]
        if k == 'TRANSFER_SMS_ENCRYPTION_KEY':
            live.append(val(notifications.get(k, '')))
        existing = {s for s in live if provided(s)}
        if len(existing) > 1:
            raise ValueError(f'{k}: production copies conflict; no keys changed')
        current = next(iter(existing), '')
        staged = val(stage.get(k, '')) if provided(stage.get(k, '')) else ''
        if current and staged and current != staged:
            # Never rotate an installed key to match a staging paste.
            # setup.env will be backed up and synchronized to the live key.
            reconciled_conflicts.append(k)
        chosen = current or staged or secrets.token_hex(length)
        if k == 'SESSION_SECRET' and len(chosen) < 32:
            raise ValueError('SESSION_SECRET is too short')
        if k != 'SESSION_SECRET' and not re.fullmatch('[a-fA-F0-9]{64}', chosen):
            raise ValueError(f'{k} must be 64 hexadecimal characters')
        keys[k] = chosen

    for k in ('FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX',
              'FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX'):
        current = val(web.get(k, '')) if provided(web.get(k, '')) else ''
        staged = val(stage.get(k, '')) if provided(stage.get(k, '')) else ''
        if current and staged and current != staged:
            reconciled_conflicts.append(k)
        chosen = current or staged or secrets.token_hex(32)
        if not re.fullmatch('[a-fA-F0-9]{64,128}', chosen):
            raise ValueError(f'{k} must be 64–128 hexadecimal characters')
        keys[k] = chosen
    if len(set(keys.values())) != len(keys):
        raise ValueError('Encryption and signing secrets cannot be reused')

    combined = {**stage, **keys}
    named = val(combined.get('PLATFORM_DB_URI', ''))
    old_alias = val(combined.get('MONGO_PLATFORM_URI', ''))
    if provided(named) and provided(old_alias) and named != old_alias:
        raise ValueError('MONGO_PLATFORM_URI and PLATFORM_DB_URI conflict')
    if not provided(named) and provided(old_alias):
        combined['PLATFORM_DB_URI'] = stage['MONGO_PLATFORM_URI']

    web_keys = ('PLATFORM_DB_URI', 'MONGO_URI_BASE', 'RESEND_API_KEY',
                'MAIL_FROM', 'FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX',
                'FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX')
    worker_keys = ('MONGO_WORKER_URI', 'RESEND_API_KEY', 'MAIL_FROM')
    notice_keys = ('MONGO_NOTIFICATION_WORKER_URI', 'RESEND_API_KEY', 'MAIL_FROM')
    selected = {
        'web': {
            **{k: combined[k] for k in web_keys if provided(combined.get(k, ''))},
            **keys,
            'NODE_ENV': 'production',
            'PORT': '3000',
            'APP_URL': 'https://classicfinhub.com',
            'TRUST_PROXY': '1',
            'REAL_MONEY_ENABLED': 'false',
        },
        'worker': {
            **{k: combined[k] for k in worker_keys if provided(combined.get(k, ''))},
            'NODE_ENV': 'production',
            'APP_URL': 'https://classicfinhub.com',
        },
        'notifications': {
            **{k: combined[k] for k in notice_keys if provided(combined.get(k, ''))},
            'TRANSFER_SMS_ENCRYPTION_KEY': keys['TRANSFER_SMS_ENCRYPTION_KEY'],
            'NODE_ENV': 'production',
            'APP_URL': 'https://classicfinhub.com',
        }
    }
    # Do not distribute web authentication keys to worker services.
    for k in ('SESSION_SECRET', 'MFA_ENCRYPTION_KEY',
              'FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX',
              'FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX'):
        selected['worker'].pop(k, None)
        selected['notifications'].pop(k, None)

    updates = {
        'setup': rewrite(L['setup'], keys),
        **{n: rewrite(L[n], selection) for n, selection in selected.items()}
    }
    changes = {n: text for n, text in updates.items()
               if text != '\n'.join(L[n]) + '\n'}
    archive = P / 'reconcile-backups'
    archive.mkdir(mode=0o700, exist_ok=True)
    os.chmod(archive, 0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    for n in changes:
        backup = archive / (files[n].name + '.' + stamp + '.bak')
        if backup.exists():
            raise ValueError('Backup path collision; rerun')
        shutil.copy2(files[n], backup)
        os.chmod(backup, 0o600)
    for n, text in changes.items():
        f = files[n]
        tmp = f.with_name(f.name + '.new-' + secrets.token_hex(6))
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as h:
            h.write(text)
            h.flush()
            os.fsync(h.fileno())
        os.replace(tmp, f)

    print('=== CLASSIC FINHUB RECONCILIATION (SECRET VALUES HIDDEN) ===')
    print('Updated:', ', '.join(changes) if changes else 'none (already reconciled)')
    for name in reconciled_conflicts:
        print(f'PRESERVED existing production key; synchronized staging: {name}')
    active = {**D['web'], **D['worker'], **D['notifications']}
    active.update(selected['web'])
    active.update(selected['worker'])
    active.update(selected['notifications'])
    for k in sorted(set(combined) | set(active)):
        if k == 'MONGO_PLATFORM_URI' and provided(combined.get('PLATFORM_DB_URI', '')):
            status = 'NORMALIZED TO PLATFORM_DB_URI'
        elif k in ('REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
                   'COOKIE_SECRET', 'PAYMENT_SECRET_KEY', 'PAYMENT_PUBLIC_KEY',
                   'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMS_PROVIDER'):
            status = 'STAGED ONLY / NOT ACTIVATED'
        elif k in keys or k in selected['web'] or k in selected['worker'] or k in selected['notifications']:
            status = 'SET' if provided(active.get(k, '')) else 'MISSING'
        else:
            status = 'STAGED ONLY / NOT DISTRIBUTED'
        print(f'{k}: {status}')
    for k, n in [('PLATFORM_DB_URI','web'),('MONGO_WORKER_URI','worker'),
                 ('MONGO_NOTIFICATION_WORKER_URI','notifications'),
                 ('RESEND_API_KEY','web'),('MAIL_FROM','web')]:
        if not provided({**D[n], **selected[n]}.get(k,'')):
            print(f'REQUIRED FOR LAUNCH: {k} still missing from {n}')
    if val(stage.get('TRANSFER_SMS_PROVIDER','none')) not in ('','none'):
        print('WARNING: SMS provider request staged, not activated; live provider validation required.')
    if val(stage.get('TENANT_BACKUPS_ENABLED','false')) == 'true':
        print('WARNING: Tenant backup option staged, not activated; requires dedicated worker and recovery evidence.')
    if val(stage.get('MFA_ENABLED','true')) == 'false' or val(web.get('MFA_ENABLED','true')) == 'false':
        print('WARNING: MFA was disabled in setup or web config. Review before launch.')
    print('Redis URL not used by current app. No Redis service created.')
    print('No DNS, Caddy, containers, or MongoDB data were changed.')

if __name__ == '__main__':
    try:
        run()
    except (OSError, ValueError) as exc:
        print(f'RECONCILIATION BLOCKED: {exc}', file=sys.stderr)
        sys.exit(2)
