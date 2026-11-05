# ClassicFin Hub v1.4.0 — Privileged Tenant MFA & Independent Mobile Money Review

**Scope:** Changes built on the v1.3.0 source, November 3, 2026. The approved dashboard styles and two-field email/password login form are unchanged. Source-level checks pass. This is **not a certification for real-money processing**.

## Completed behavior

1. **Identity and privileged sign-in:** `/signin` still has just email and password; the global identity directory decides the dashboard. Platform Super Admin, Tenant Owner, Reconciliation Officer, and Auditor must enroll or challenge an authenticator after password validation and before they gain a usable privileged session. Existing users with those tenant roles are enrolled on next login. The authenticator secret is encrypted at rest; single-use time counters prevent OTP replays; password rotation invalidates sessions using `authVersion`. Standard Mobile Money Operators and Viewers retain the two-field sign-in route.
2. **Authorization:** Permission rules are server-controlled. Newly invitable Reconciliation Officers can independently review Mobile Money operational records, view reports and audit events, but cannot record cash-in/out or manage staff. Mobile Money Operators can record their own items but cannot review or export the whole tenant. Auditors can view reports and audit records but cannot review. Owners can review another operator's records but never their own.
3. **Independent review lifecycle:** A recorded operation is `pending_verification` at the *provider* level. A separate `reviewState` can be `awaiting_review`, `accepted`, or `disputed`. The review requires an explanatory note (12–400 characters), excludes self-review, prevents replay or concurrent double-decisions with an atomic update, and creates an audit event in the **same MongoDB transaction**. Internal review never modifies provider status, ledger balances, or cash drawers. Old records without a reviewState are treated as `awaiting_review` without rewriting them.
4. **Role-adaptive UI:** The existing Overview, Mobile Money, Operations Reports, Staff & Roles and sidebar style remain. Operators see a recording form; reconciliation staff see a live review queue and decision forms; auditors get read-only records. The `/tenant/audit` page shows the latest 100 tenant-scoped audit events and is available only to permitted roles. Reports and CSV export distinguish internal review from unverified provider settlement; CSV text is formula-escaped.
5. **Tenant provisioning safety:** Financial uniqueness indexes are built before platform tenant/invitation creation, so an index setup failure cannot publish an unusable tenant. Tenant connection names still come only from validated stored slugs and share one bounded Mongo connection pool.

## Apply the patch to the v1.3.0 codebase

Before applying, commit or stash any existing changes. The patch is **v1.3.0 to v1.4.0**, not applicable directly to older v1.1 or v1.2 branches.

```bash
git status --short
git apply --check classicfin-v1.3-to-v1.4.patch
git apply classicfin-v1.3-to-v1.4.patch
npm ci
npm run check
npm test
npm run perf:assets
npm run perf:smoke
```

Use a local replica set (for example Docker Desktop) to run the **real-database gates**:

```bash
npm run db:dev:up
npm run db:doctor
npm run indexes
npm run auth:integration
npm run review:integration
npm run db:integration
```

The last three commands use random scratch records/databases and reject non-local MongoDB URIs. `auth:integration` exercises HTTP login, privileged MFA, recording, second-person review, CSV, role menus, reset and session revocation. `review:integration` separately verifies MongoDB idempotency, review concurrency and tenant database boundaries. Integration tests **were not run in the editing container**: neither Docker nor a MongoDB server was available. Do not run scratch tests against production.

### Required environment

- `NODE_ENV=production`, `APP_URL` with the actual HTTPS canonical origin, strong `SESSION_SECRET`, `TRUST_PROXY` matching your Caddy proxy hops.
- `MONGO_PLATFORM_URI` for a **secured authenticated MongoDB replica set**, with backups and per-environment network restrictions. Do not expose MongoDB publicly.
- `MFA_ENCRYPTION_KEY` = 64 hex characters (32 random bytes). **Back up this key securely:** losing it makes existing MFA enrollments unreadable. Never commit it, log it or embed it in a container image.
- `RESEND_API_KEY` and verified `MAIL_FROM` for password-recovery emails; test actual delivery, not only API acceptance.
- Run existing account migration first for deployments upgrading from an earlier version: `npm run auth:migrate`, inspect dry-run, then `npm run auth:migrate -- --apply`. Back up before applying to production. Run `npm run indexes` before serving traffic.

### Controlled tenant MFA recovery (offline)

Do **not** offer email-only MFA removal, a public recovery URL, or an MFA bypass switch. If a Tenant Owner, Reconciliation Officer or Auditor loses their authenticator, an authorized support operator can use `npm run tenant:mfa-recover` only from an operations host. It requires **both** the verified Super Admin password and the affected tenant user's current password, plus a unique support case reference and exact approval phrase. The default is dry-run. `--apply` executes a database transaction writing platform + tenant audit events, invalidates all existing sessions by incrementing `authVersion` and requires fresh authenticator enrollment at the next sign-in. This is separate from the user's routine two-field login.

Prepare two **distinct owner-only files**, holding the administrator and affected user's passwords. Do not write credentials or the MFA secret into shell history, Git, tickets or logs. Set environment variables `MFA_TENANT_RECOVERY_ADMIN_EMAIL`, `MFA_TENANT_RECOVERY_TARGET_EMAIL`, `MFA_TENANT_RECOVERY_ADMIN_PASSWORD_FILE`, `MFA_TENANT_RECOVERY_TARGET_PASSWORD_FILE`, `MFA_TENANT_RECOVERY_CASE` (an approved support case ID, 8–80 safe characters) and `MFA_TENANT_RECOVERY_CONFIRM` equal to `RESET TENANT MFA FOR <target-email>` (with the real target email). Run:

```bash
npm run tenant:mfa-recover            # validates identity, two passwords, config; no changes
npm run tenant:mfa-recover -- --apply # deliberate audited reset of that tenant account
```

Independently verify user identity and support approval before using `--apply`. Securely erase temporary password files afterwards. This script has **not** been run against a live database in the editing container.

### Production release-blocking checks

- Run `npm audit --audit-level=high` **against the live npm registry** and remediate high/critical dependencies; the editing environment returned DNS `EAI_AGAIN`. An offline audit reporting zero cannot certify this gate.
- Prove production Mongo replica-set transactions, tenant isolation, index uniqueness, database/restore testing, idempotency and concurrent review under load.
- Verify real email delivery, MFA enrollment and account recovery including loss of authenticator, and incident response for compromised keys.
- Perform independent authorized penetration testing, load/soak/failure tests, backups, restore, WAF, operational alerts, data retention, data privacy and applicable regulated financial-activity assessments.
- Do **not** set `REAL_MONEY_ENABLED=true`. External settlement/provider verification, double-entry ledger, reversals, disputes with providers and regulatory permissions are not implemented or certified. A manually accepted operational record is not a successful transfer.
- Public SEO is enabled only on the correct production domain. Verify the canonical origin, sitemap, robots, structured data and deployed Core Web Vitals; private dashboards remain `noindex` and outside AI-crawler resources. `llms.txt` is informational, not a security boundary or guaranteed SEO ranking mechanism.

### Recorded verification in this release

Unit/source tests, EJS render tests, public-asset size budgets and local-process HTTP smoke are covered by `npm test`, `npm run check`, `npm run perf:assets`, and `npm run perf:smoke`. Live MongoDB, actual email, third-party financial providers, production browser performance and registry dependency advisories cannot be claimed to have passed without a connected environment.
