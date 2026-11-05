# ClassicFin Hub — Security and local-development fixes (November 3, 2026)

This patch is applied to the existing **1.1.0 secured foundation**, with all original dashboard EJS templates, CSS, public graphics and design unchanged.

### Fixed in source and tested

1. Corrected login rate limiting: all sign-in attempts now count; previously invalid sign-ins redirected 303 and were incorrectly excluded from limits. A regression test makes eight requests and verifies the ninth is rate-limited.
2. Ensured the health-ready endpoint checks for a writable MongoDB replica set PRIMARY. The app continues to reject standalone MongoDB; there is **no unsafe fallback**.
3. Exempted readiness/liveness endpoints from public request rate limiting so monitoring does not cause false outage alarms.
4. Fixed the Mobile Money list/export distinction: large tenant history can still render short dashboard lists; an export of more than 5,000 rows remains rejected rather than truncated.
5. Added safe Docker Desktop local replica-set setup on loopback port 27018 and cross-platform `dev:local`, `db:doctor` and `db:integration` tooling.
6. Added on-device npm advisory remediation (`npm run deps:repair`) that avoids `npm audit fix --force`; adds an automated CI high/critical gate.
7. Added precise Git Bash and native Windows MongoDB service instructions, with safe migration/backup warnings.

### Evidence

- `npm test`: **21/21 passed**, including new throttle and MongoDB topology/report tests.
- `npm run check`: **296 JS/EJS** source files passed syntax/template compilation.
- `public/css/dashboard.css`: identical SHA-256 to the supplied secured foundation.
- `package.json` dependencies remain consistent with `package-lock.json` so `npm ci` remains valid.

### Not claimed completed

- Local Docker/MongoDB transaction test could not be executed because Docker/mongod were unavailable in the editing environment. Run `npm run db:dev:up`, `npm run db:doctor` and `npm run db:integration` on the Windows host.
- Full `npm audit` could not be executed because the npm registry could not be reached in this environment. **The reported 12 advisories are not claimed resolved.** Run `npm run deps:repair`, inspect any remaining advisories, regenerate and commit both package files, run `npm ci && npm test`.
- MFA, distributed rate limits, full provider reconciliation, regulated KYC/AML, disaster recovery, independent pentest and real-money processing remain release blockers. Real-money operations stay disabled.
