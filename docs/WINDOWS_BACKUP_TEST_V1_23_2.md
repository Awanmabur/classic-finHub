# ClassicFin Hub v1.23.2 — Windows backup test permission compatibility

## Confirmed cause

Windows `fs.stat().mode` does not represent Unix discretionary access controls the same way Linux does. The Windows report `54 !== 0` is the decimal value of the lower permission bits (`0o66`), **not a backup executable exit code**. The two failing assertions were in `tests/backup-recovery.test.js` and `tests/offsite-backup.test.js`.

## Changes

- Retained strict `0600` group/other mode assertions on POSIX systems.
- On Windows, avoided interpreting synthetic Unix permission bits as proof of access control.
- All checks of AES-256-GCM encryption/authentication, corruption rejection, S3 versioning, immutable COMPLIANCE retention, digest, and restore verification remain active.
- No changes to any production backup or offsite-backup service.
- Bumped package version to 1.23.2; lockfile root version kept in sync.

**Security limit:** These automated tests do **not** establish private Windows NTFS ACLs. If real backup artifacts or their encryption keys are stored on Windows, independently review Windows ACLs (for example with `icacls`). Production backup secrets and files should use private dedicated filesystem identities and tested retention on the intended Linux deployment. Do not infer that a Windows test pass proves OS-level confidentiality.

## Re-run locally

```bash
npm run check
node --test tests/backup-recovery.test.js tests/offsite-backup.test.js
npm test
npm audit --audit-level=moderate
```

This patch does not fix npm dependency vulnerabilities, prove live MongoDB integration, or claim production readiness.
