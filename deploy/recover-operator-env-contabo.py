#!/usr/bin/env python3
"""Recover mistakenly edited setup.env. safely without exposing credential values.

Never replaces previously generated application-owned signing or encryption keys.
Backs up operator files before edits and preserves any conflicting manual values.
"""
from __future__ import annotations
import datetime
import os
import pathlib
import re
import secrets
import stat
import sys

ROOT = pathlib.Path('/etc/classicfin')
STAGE = ROOT / 'setup.env'
TYPO = ROOT / 'setup.env.'
WEB = ROOT / 'web.env'
BACKUPS = ROOT / 'reconcile-backups'
ENTRY = re.compile(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$')
SECRET_KEYS = {
    'SESSION_SECRET', 'MFA_ENCRYPTION_KEY', 'TRANSFER_SMS_ENCRYPTION_KEY',
    'FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX',
    'FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX'
}

def guarded_file(path, *, optional=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return False
        raise RuntimeError(f'Required configuration file missing: {path.name}')
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
        raise RuntimeError(f'Unsafe configuration file: {path.name}')
    os.chmod(path, 0o600)
    return True

def parse(path):
    mapping, lines = {}, path.read_text(encoding='utf-8-sig').splitlines()
    for number, line in enumerate(lines, 1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = ENTRY.match(line)
        if not match:
            raise RuntimeError(f'Malformed {path.name} line {number}; no credentials displayed')
        key, raw = match.groups()
        if key in mapping:
            raise RuntimeError(f'Duplicate {key} in {path.name}')
        mapping[key] = raw
    return mapping, lines

def plain(raw):
    result = raw.strip()
    return result[1:-1] if len(result) > 1 and result[0] == result[-1] and result[0] in ("'", '"') else result

def usable(raw):
    value = plain(raw)
    return bool(value) and not re.search(r'change[-_]?me|replace[-_]|your[-_]|placeholder|<[^>]+>', value, re.I)

def replace(lines, updates):
    written, out = set(), []
    for line in lines:
        match = ENTRY.match(line)
        if match and match.group(1) in updates:
            key = match.group(1)
            out.append(f'{key}={updates[key]}')
            written.add(key)
        else:
            out.append(line)
    for key, value in updates.items():
        if key not in written:
            out.append(f'{key}={value}')
    return '\n'.join(out) + '\n'

def save(path, old_lines, updates, suffix):
    if not updates:
        return False
    new_content = replace(old_lines, updates)
    if new_content == '\n'.join(old_lines) + '\n':
        return False
    backup = BACKUPS / f'{path.name}.pre-recover-{suffix}.bak'
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(path.read_bytes())
        target.flush()
        os.fsync(target.fileno())
    temp = path.with_name(f'{path.name}.tmp-{secrets.token_hex(6)}')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        target.write(new_content)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temp, path)
    return True

def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run this script as root via sudo')
    os.umask(0o077)
    if not ROOT.is_dir() or ROOT.is_symlink():
        raise RuntimeError('Protected configuration directory missing or unsafe')
    guarded_file(STAGE)
    guarded_file(WEB)
    typo_exists = guarded_file(TYPO, optional=True)
    base, base_lines = parse(STAGE)
    web, web_lines = parse(WEB)
    imported, conflicts = [], []
    changes = {}
    if typo_exists:
        staged, _ = parse(TYPO)
        for key, new_raw in staged.items():
            if key == 'MFA_ENABLED' or key in SECRET_KEYS:
                continue
            if not usable(new_raw):
                continue
            current_raw = base.get(key, '')
            if not usable(current_raw):
                changes[key] = new_raw
                imported.append(key)
            elif plain(current_raw) != plain(new_raw):
                conflicts.append(key)
    # User-approved temporary MFA disablement, in actual runtime web env too.
    changes['MFA_ENABLED'] = 'false'
    web_changes = {'MFA_ENABLED': 'false'}

    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    if BACKUPS.is_symlink() or not BACKUPS.is_dir():
        raise RuntimeError('Unsafe backup directory')
    os.chmod(BACKUPS, 0o700)
    suffix = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    updated_stage = save(STAGE, base_lines, changes, suffix)
    updated_web = save(WEB, web_lines, web_changes, suffix)

    print('=== FINHUB STAGING RECOVERY (NO SECRETS DISPLAYED) ===')
    print('Trailing-dot staging file:', 'FOUND / secured to mode 600' if typo_exists else 'NOT FOUND')
    print('Canonical setup.env:', 'UPDATED' if updated_stage else 'UNCHANGED')
    print('Live web.env:', 'UPDATED' if updated_web else 'UNCHANGED')
    print('MFA_ENABLED: false (setup and web)')
    print('Imported nonempty values:', ', '.join(imported) if imported else 'none')
    print('Preserved original values despite staging conflicts:',
          ', '.join(conflicts) if conflicts else 'none')
    print('Existing session, MFA, transfer and HMAC keys: never overwritten from trailing-dot file')
    print('Original versions backed up privately under /etc/classicfin/reconcile-backups/')
    if conflicts:
        print('Review conflicting variable names above before changing existing credentials.')
    if typo_exists:
        print('The trailing-dot file remains untouched except for protected file permissions.')
    print('No Docker, DNS, Caddy or database changes.')

if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f'STOPPED: {error}', file=sys.stderr)
        sys.exit(2)
