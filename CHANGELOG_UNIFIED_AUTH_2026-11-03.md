# ClassicFin Hub v1.2.0 — Unified Account Access

## Implemented

- Existing styled `/signin` form now collects **only email and password** (plus hidden CSRF token); removed dashboard selector, tenant slug, and nonfunctional remember-device checkbox.
- Platform-wide unique email directory stored centrally with an account-to-platform/tenant binding and no duplicate credential storage.
- Authentication resolves verified account type in the backend. Super Admin enters `/platform/dashboard`; tenant owners/staff enter `/tenant/dashboard` with role- and plan-filtered navigation and enforcement.
- One-time Super Admin bootstrap initializes both the account and global identity in one transaction; unique bootstrap marker rejects concurrent first-admin creation.
- Owner/staff invitation acceptance writes the tenant user and global account identity atomically; duplicate emails fail closed.
- Controlled, dry-run-first identity migration for existing accounts, including duplicate email detection and idempotent application.
- New Mongo-backed IP and email login throttling, hashed subject security events, active-account validation, absolute session lifetime, and session version checks on every protected route.
- Real password recovery API integration using the Resend HTTPS endpoint (requires verified external credentials), hashed 15-minute single-use reset tokens, transactional rotation, invalidation of previous sessions and security notification.
- Offline controlled recovery command for an EXISTING Super Admin, with password file and audit event; no default/demo passwords.
- Removed `unsafe-inline` script execution from the active CSP; replaced two inline dashboard click handlers with an external handler. No changes to dashboard CSS.
- Added HTTP/unit tests and a separate loopback-MongoDB integration probe for real routing, roles, password reset and session revocation.

## Not certified / requires deployment proof

- Live MongoDB integration probe (`npm run auth:integration`) could not run here because no MongoDB server is available in the editing environment.
- Transactional email provider delivery needs verified key, sending domain and actual inbox delivery test; chosen adapter is **Resend**, not Purelymail SMTP.
- Previous `npm ci` vulnerabilities cannot be claimed resolved without a live npm advisory audit and dependency upgrades.
- Mandatory financial-platform release gates: privileged MFA, testing and review of infrastructure, strong style CSP, independent pen test/ASVS, alerting, backup restore, and payment-provider transaction/reconciliation checks.
- Legacy banking/forex/transfers and actual mobile-money settlement are still not enabled.

Read `docs/UNIFIED_AUTH_RELEASE.md` before applying to a database with existing users.
