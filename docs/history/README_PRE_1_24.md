# Historical README before 1.24.0

This records earlier releases and superseded limitations. Use the [current README](../../README.md), [launch status](../LAUNCH_STATUS.md) and [launch runbook](../LAUNCH_RUNBOOK.md) for current behavior and deployment decisions. References to removed legacy files describe earlier revisions.

# Approved tenant workspace, configurable plans and Android SMS capture

Platform administrators can now create versioned custom plans, configure prices,
modules and quotas, and publish separate manual and higher-priced SMS-assisted
tiers. Tenant transaction branches come from account/device assignments; the
workspace uses real database-backed operation dialogs and cash/activity data.
Manual entry remains available.

- [Approved UI implementation and remaining boundaries](../../docs/APPROVED_UI_PARITY.md)
- [Customers and accounts](../../CUSTOMERS_AND_ACCOUNTS.md)
- [Expenses and daily reports](../../docs/EXPENSES_AND_REPORTS.md)
- [Tenant settings and branding](../../docs/TENANT_WORKSPACE_CONFIGURATION.md)
- [Configure plans, SMS capture and the workspace](../../docs/SMS_AND_PLAN_CONFIGURATION.md)
- [Connect the Android phone](../../tools/android-sms-relay/README.md)
- [Automatic branch behavior](../../docs/AUTOMATIC_BRANCH_CONTEXT.md)

Automatic capture needs the installed Android relay and a reachable HTTPS app.
Unmatched network SMS is queued for review; provider settlement is not inferred.

---

# Current review and repairs — 5 November 2026

This repository now uses the uploaded v1.23.2 application, with verified repairs
for tenant creation, catalogue/ledger transactions, cash closing, security,
dependencies and the active UI. The approved design is the root `index.html`;
it is retained exactly as uploaded.

- [Prioritized project issue register and remaining features](../../docs/PROJECT_REVIEW.md)
- [Security findings and validation](../../docs/SECURITY_REVIEW_2026_11_05.md)
- [UI fixes and remaining design differences](../../docs/UI_REVIEW.md)
- [Prepared cloud environment startup](../../docs/CLOUD_SETUP.md)

The local release gate, real tenant creation/activation in Chromium, and the
connected dependency audit passed. This does not enable provider settlement or
complete the remaining workflows listed in the issue register. Historical release
notes below describe earlier stages; use the current review and mounted routes
for the present capability boundary.

---

# ClassicFin Hub v1.23 — Cross-module correctness and performance

## v1.23 cross-module correctness release

This update preserves the original dashboard layout. It corrects physical cash reporting
for ObjectId-backed branch records, preserves independent-module entitlements
when the base plan changes, accounts for standalone seat/branch capacity on
plan upgrades and downgrades, prevents overlapping reporting sources from being
summed into a fictitious activity total, and runs independent Overview reads
concurrently. See `docs/CROSS_MODULE_INTEGRATION_V1_23.md` for validation,
permissions and rollout guidance.


This release improves existing forms without changing the approved dashboard styling or introducing new module dependencies. See [Selection-first release guide](../../docs/SELECTION_FIRST_V1_22.md).

# ClassicFin Hub v1.21 — Independent Notifications

Notifications is now a standalone, independently subscribable module with tenant-scoped staff inboxes, versioned templates, opt-in email queueing, audit trails, read markers, secured worker retries and an aggregate-only reporting adapter. Email status records provider **acceptance**, not final delivery; SMS remains disabled pending a real provider. Account-security email remains independent of the add-on. The original dashboard styling is unchanged.

**Verification:** `npm run check`, `npm test`, `npm run notification:integration` (loopback MongoDB required), `npm run notification:doctor` (separate worker database credentials), and `npm run release:gate`. Live provider delivery, npm advisory clearance, database integration and production rollback/recovery still need external evidence. See [Notifications v1.21](../../docs/NOTIFICATIONS_V1_21.md).

---

# ClassicFin Hub v1.15 — Physical cash shifts and independent reconciliation

## v1.18 — Independent Forex quotation module

Forex is now an independent subscription, like Mobile Money, Money Transfer, Banking and Operations Reports. It has branch-controlled indicative rates, independent rate and quote reviews, exact fixed-point conversion, immutable quote snapshots, idempotency, monthly quotas, expiry, audits, and an optional Reports adapter. **These are internal quotations, not executed FX trades.** See `docs/FOREX_MODULE_V1_18.md`. Run `npm run forex:integration` with a disposable local replica set.


## v1.16 independently subscribed Money Transfer requests

The Money Transfer module now supports tenant/branch-scoped sender and beneficiary contacts, immutable transfer requests, independent reviewer decisions, cancellation, expiry, internal acknowledgement printing, separately metered subscriptions, and a report-source adapter for the optional standalone Operations Reports module. **This records internal requests only: no funds are collected, transferred, paid out or settled.** Legacy send/payout entrypoints still return 501. See `docs/MONEY_TRANSFER_MODULE_V1_16.md`.

Additional checks: `npm run transfer:integration` (isolated localhost MongoDB), `npm run transfer:expiry` (database-connected scheduled task). Live MongoDB tests, online npm audit, provider validation and staging security/recovery tests remain release gates.


This upgrade extends independently subscribed Mobile Money operations with actual database-backed physical-cash shifts, mandatory independent opening verification, recorded transaction linkage, counted closing balances, two-person closing decisions, a controlled variance escalation path, auditable history, printable **non-settlement** acknowledgements, and an optional source adapter for standalone Operations Reports. Provider e-float and settlement are NOT implemented by this internal workflow. See [v1.15 cash controls](../../docs/MOBILE_MONEY_CASH_CONTROL_V1_15.md).

**Verification:** `npm run check`, `npm test`, `npm run perf:assets`, `npm run cash:integration` (isolated loopback MongoDB replica set required) and `npm run release:gate` (also requires an online npm audit). No credentials, production deployment or provider transactions are included. The existing dashboard stylesheet remains unchanged.

---

# ClassicFin Hub v1.14 — Independent Mobile Money operations

This release extends the v1.13 independently subscribed **Mobile Money** and **Operations Reports** modules. It adds an audited two-person correction/void process for unverified operational entries, detailed record history with keyset pagination, branch- and operator-scoped access, full correction decision chronology, and correction-aware aggregate reports. The approved dashboard stylesheet and all existing public pages remain untouched.

**What “void” means here:** it invalidates a mistaken **internal record**; it never sends a refund, confirms settlement, changes provider funds or posts a ledger entry. For production financial settlement, an actual provider adapter and independent reconciliation evidence still have to be tested. Read [the Mobile Money v1.14 guide](../../docs/MOBILE_MONEY_OPERATIONS_V1_14.md) and [change log](../../CHANGELOG_MOBILE_MONEY_V1_14.md).

Verification: `npm run check`, `npm test`, `npm run mobile-money:integration` (loopback MongoDB required) and `npm run release:gate`. A passing source suite is **not** a production certification. Third-party credentials are never committed in this repository.

---

# ClassicFin Hub v1.11 — internal accounting foundation

This upgrade adds an **internal-only, append-only double-entry ledger** with exact integer minor units, branch and tenant boundaries, idempotent source references, transactional audit records, controlled reversal journals, trial balance and a bounded integrity doctor. **No customer funds, provider settlements or legacy demonstration transactions are automatically posted.** The old `postEntry()` entrypoint remains disabled and `REAL_MONEY_ENABLED=true` still fails startup. The approved dashboard CSS and public SEO assets remain untouched.

Run `npm run check`, `npm test`, `npm run ledger:integration` (a local replica set is required) and `npm run release:gate`. Read [Financial ledger v1.11](../../docs/FINANCIAL_LEDGER_FOUNDATION_V1_11.md) before considering any financial deployment. Live database testing, independent financial controls, npm advisory clearance and provider reconciliation remain release blockers.

---

## Release v1.9 — infrastructure recovery and immutable rollout

This release adds the dedicated **encrypted full-replica-set backup job**, authenticated backup verification, backup-age monitoring, isolated restore rehearsal, and digest-pinned web/worker deployment with a readiness-based rollback. All modules and dashboard styles from v1.8 remain unchanged. Read [`docs/DISASTER_RECOVERY_V1_9.md`](../../docs/DISASTER_RECOVERY_V1_9.md) **before configuring secrets, enabling the backup timer or releasing a financial workload**. Unit tests alone do not certify backup recovery or production readiness.

# ClassicFin Hub v1.8 — Durable background operations

This release preserves the approved dashboards, tenant and branch authorization, two-field login, MFA, and plan controls from v1.7. The next reusable infrastructure layer is a **MongoDB transaction-backed outbox and independently supervised worker**, currently connected to **manual subscription grant/revocation notifications**. Queueing does **not** send mail synchronously or signify delivery; the Super Admin **Background Operations** dashboard distinguishes pending, processing, provider-accepted and dead-letter events.

Run `npm run worker` as a separate process alongside `npm start`; for production use the two-service `deploy/compose.prod.yml`. The worker requires the **same secured MongoDB replica set** (a separate least-privilege database account in production) and a verified Resend configuration (`RESEND_API_KEY`, `MAIL_FROM`). When email is unavailable, records do not vanish: events dead-letter and require an audited manual redrive after the provider is configured. **No private tenant data, financial settlement, or credential-bearing messages are processed by this queue.**

Local verification: `npm run check`, `npm test`, `npm run perf:assets`, `npm run outbox:integration` (loopback-only MongoDB replica set). Monitoring: `npm run worker:doctor` and alert on nonzero exit. See [Durable operations v1.8](../../docs/DURABLE_OPERATIONS_V1_8.md). **Live provider delivery, production availability, database restoration and third-party security audits remain unverified release gates.**

---

# ClassicFin Hub v1.7 — Commercial control plane and infrastructure hardening

## v1.7 — commercial controls (latest)

The original UI, role-based dashboards, two-field email/password login, and privileged MFA remain intact. This release adds **persisted versioned plan publication, safe trial/legacy migration, audited manual subscription grants, revocation, true tenant module/seat/branch entitlements, and transactional monthly Mobile Money recording quotas**. It also adds the platform Subscriptions view and a tenant billing/usage view. **No payment is claimed collected; provider settlement, actual invoicing and recurring payment processing are disabled.**

Full architecture, security boundaries, release evidence and Windows steps: [Commercial control plane v1.7](../../docs/COMMERCIAL_CONTROL_PLANE_V1_7.md).

For an isolated new local database, after `npm run db:dev:up` run `npm run indexes` then `npm run catalog:publish -- --apply` before creating tenants. For upgrades, back up existing data and perform `npm run commercial:migrate` dry run before any write. Existing active tenants **require deliberate admin review/grants**, not automatic migration.


**Release status:** Source tests passed; live production and financial settlement are **NOT** certified. Read [`docs/INFRASTRUCTURE_FIRST_V1_6.md`](../../docs/INFRASTRUCTURE_FIRST_V1_6.md) for verified capability matrix, migrations, architecture, release gates, and remaining infrastructure work.

# ClassicFin Hub

**Branch, staff and audited administration release v1.5.0 (3 November 2026)**. This is the user's existing ClassicFin Hub project, not a new frontend redesign. The original public pages, visual assets and dashboard stylesheet are retained.

> **NOT certified for production financial services.** No provider has been integrated, no real transfers are enabled, and no live payment settlement is claimed. Legacy demonstration operations are deliberately inaccessible while they are refactored.

## What changed in v1.5.0

Read **[Platform and tenant administration implementation and upgrade guide](../../docs/ADMINISTRATION_AND_BRANCH_CONTROL_V1_5.md)**. Owners can create/edit/archive/restore subscription-limited branches; invite users with fixed roles, active branch and module assignments; change staff details/roles/branches/modules with session revocation; disable/re-enable staff or revoke invitations; and inspect live tenant audit records. The platform now shows actual administration activity and supports audited tenant profile and status changes. All new Mobile Money records bind to a valid active branch. This preserves the original dashboard CSS, form-based email/password login, MFA, and public SEO configuration. *This release is not certified for real-money settlement.*

## What changed in v1.4.0

Read **[v1.4 security, operational review and release gates](../../docs/PRIVILEGED_TENANT_MFA_AND_REVIEW_V1_4.md)**. Owner, Reconciliation Officer and Auditor roles now require an authenticator verification step after the existing two-field sign-in. Mobile Money entries can undergo independent internal evidence review or dispute (without falsely claiming provider settlement), with an atomic audit event, review status in CSV reports and a role-limited tenant Audit Trail. The reviewer must differ from the operator. Tenant financial indexes must build before a new workspace invitation is published. `npm run auth:integration` and `npm run review:integration
npm run admin:integration` target local scratch databases only. A dual-credential, audited offline `npm run tenant:mfa-recover` handles lost authenticators without creating a public bypass; see guide.

## What changed in v1.3.0

Read **[Security, performance, SEO, deployment and verified release gates](../../docs/SECURITY_PERFORMANCE_SEO_RELEASE_V1_3.md)** before deploying. Administrator MFA, crawler metadata, image WebP optimizations, tenant-aware financial throttling, structured logs, safer operational deployment files and fail-closed legacy simulation services have been added. The existing dashboard visual stylesheet remains unchanged. This is **not a production certification**.

## Two-field login and account routing

**Email + password only.** Sign in at `/signin`; the server looks up one globally unique account identity and routes verified platform Super Admins to `/platform/dashboard` and tenant users to `/tenant/dashboard`. No tenant slug or role selector appears. Tenant roles, subscription entitlements and a fixed permission map determine dashboard navigation. Existing account data requires `npm run auth:migrate` (audit) then `npm run auth:migrate -- --apply` (atomic-safe directory mapping) **before** switching live traffic. Duplicate emails across tenants/roles are rejected, not arbitrarily resolved. See [Unified login and rollout guide](../../docs/UNIFIED_AUTH_RELEASE.md).

## What runs

- Public EJS pages, pricing, signup enquiry and appointment submission (Mongo-backed).
- Unified email/password sign-in, verified Super Admin bootstrap, live platform overview, tenant directory, one-time owner invitation, plans and module catalogue.
- Tenant owner/staff authentication with global unique email routing, server-defined roles, per-tenant logical Mongo databases, bounded shared Mongo pool, subscription module entitlements.
- Tenant overview, Mobile Money **unverified operational recording**, independently reviewed or disputed records, audit trail, network activity, reports and CSV export. Internal review never settles funds or posts balances.
- Tenant-owner staff invitations, plan user seat reservation, disable/revoke access, session-backed CSRF protection, secure cookie settings, scoped records, protected redirects.
- Password recovery through a configured Resend API key and verified sending address; expiring hashed reset tokens, one-time use and session revocation on password change. No fake email sends.

## Setup

Requires Node.js 22+, and **MongoDB deployed as a replica set** (or MongoDB Atlas); do not run this financial recording workflow on standalone MongoDB. For Windows/Git Bash and Docker Desktop local setup, see [Windows startup and dependency security](../../docs/WINDOWS_STARTUP_AND_SECURITY.md).

```bash
npm ci
cp .env.example .env
# Edit .env with the real MongoDB replica-set URI, APP_URL, a unique SESSION_SECRET of 32+ characters.
npm run check
npm test
npm run db:doctor
npm run indexes
npm run auth:migrate
npm run auth:migrate -- --apply
# Against an isolated local replica set only:
npm run auth:integration
npm run review:integration
```

Bootstrap the first platform admin **once only**. On Linux/Contabo, prepare a private file containing a strong password, owner-readable only. Do not put a password in Git or in shell history:

```bash
umask 077
read -rs -p 'Initial administrator password: ' PASS; echo
printf '%s' "$PASS" > /tmp/classicfin-admin-pass
unset PASS
chmod 600 /tmp/classicfin-admin-pass
BOOTSTRAP_ADMIN_EMAIL='admin@example.com' BOOTSTRAP_PASSWORD_FILE='/tmp/classicfin-admin-pass' npm run bootstrap
shred -u /tmp/classicfin-admin-pass
npm start
```

Replace the example email with a real administrator email. Platform Super Admins and privileged tenant staff begin sign-in at `/signin` using only email and password; a **separate protected authenticator step** is mandatory for Super Admins, Tenant Owners, Reconciliation Officers and Auditors before opening the dashboard. Tenants are created from the platform dashboard; the owner receives a **one-time invitation URL that the admin must share securely**. Staff invitations work similarly. Emails are **not** automatically sent. The activation token is in the browser URL fragment, not in reverse-proxy GET logs.

For production behind one trusted Caddy reverse proxy set `NODE_ENV=production`, `APP_URL=https://your-actual-domain`, `TRUST_PROXY=1`, a strong `SESSION_SECRET`, and restrictive Mongo permissions. Never expose Mongo to the public internet. Protect environment secrets, use encrypted backups and test recovery.

## Quick local Windows development

With Docker Desktop running, from your project directory:

```bash
npm ci
npm run db:dev:up
npm run dev:local
```

This uses an **isolated**, persistent, single-node development replica set on `127.0.0.1:27018` and does not change your existing native MongoDB. Use `npm run db:doctor` and `npm run db:integration` to diagnose and transaction-test a local URI from `.env`, or see the [native Windows service steps](../../docs/WINDOWS_STARTUP_AND_SECURITY.md). Production must use a secured deployment, not this development container.

**Email reset configuration:** `RESEND_API_KEY` and `MAIL_FROM` must be configured and live-tested. This is a Resend HTTPS integration, **not** Purelymail SMTP. Delivery is not confirmed merely by receiving an API acceptance.

**Dependency advisory gate:** The connected review on 5 November 2026 repaired six vulnerable packages in the uploaded lockfile and verified zero current npm audit findings. Run `npm ci`, `npm audit`, and the complete release gate for subsequent changes; this point-in-time result does not waive future advisory checks. Do not blindly run `npm audit fix --force`.

## Operational endpoints

- `GET /health/live` — process liveness.
- `GET /health/ready` — readiness based on Mongo connectivity (HTTP 503 when disconnected).
- `GET /robots.txt` and `/sitemap.xml` — crawl directives for the public site.
- `/platform/*` and `/tenant/*` require authentication; no implicit demo login.

## Before production

Read [Architecture and release gates](../../docs/ARCHITECTURE_AND_RELEASE.md), including current limitations, mandatory external infrastructure, security testing and compliance. Production money movement stays disabled until an approved, licensed provider and reconciliation workflow are implemented and verified.

## v1.10 — Immutable offsite backup and incident monitoring

The v1.10 infrastructure release adds an AWS S3 Object Lock (COMPLIANCE)
backup replication adapter, checksum/version/retention verification, private
receipts, exact-version disaster download with authenticated AES-GCM checks,
4-hourly local/offsite health verification, systemd failure alerts, and an
external heartbeat for dead-host detection. User-facing dashboards, roles,
subscriptions, Mobile Money recording, and the existing UI are unchanged.

See [`docs/OFFSITE_IMMUTABILITY_AND_MONITORING_V1_10.md`](../../docs/OFFSITE_IMMUTABILITY_AND_MONITORING_V1_10.md)
for credential separation, required AWS S3/IAM permissions, systemd installation,
alert receiver, offsite retrieval and recovery rehearsal procedures.

Commands: `npm run offsite:upload`, `npm run offsite:doctor`,
`npm run offsite:fetch -- <object-key> <version-id>`, `npm run ops:doctor`,
`npm run ops:test-alert`.

**Release gate:** Source tests do not prove an offsite upload or real database
restore. Do not enable real financial settlement until actual offsite/restore,
security audit, dependency scan, load, provider reconciliation and operational
response tests pass. AWS S3 PutObject is deliberately limited to <=5 GB
per encrypted archive; larger datasets need a reviewed multipart/PITR solution.

## v1.12 — Financial transaction and reconciliation infrastructure

The v1.12 **internal-only** foundation adds tenant-scoped financial intents, a
verified internal-gateway evidence contract, separation of provider callbacks
from settlement statements, exception records, independent reconciliation, and
atomic double-entry journal posting. This does **not** enable real provider
payments, account balances, banking/FX operations, or a public settlement API.
The signed gateway protocol is for trusted internal adapters **after** they
independently confirm source-provider authenticity; it is not a substitute for
MTN, Airtel, PesaPal, bank, or other provider-specific verification rules.

See `docs/FINANCIAL_TRANSACTION_ENGINE_V1_12.md` for design, invariants,
recovery, staging test commands and production release gates. The independent
local database check is `npm run financial:integration` (disposable MongoDB
replica set only). `npm run release:gate` now requires that check alongside the
existing tests, database checks, and online dependency audit.

## v1.13 — Independently subscribed modules and cross-module Operations Reports

- Mobile Money recording/review and Operations Reports are independent entitlements. A Modular Workspace can have either, both, or neither. Existing published plans remain immutable; module grants never assert that a customer has paid.
- Super Admins grant, renew, or revoke individual modules on the tenant detail page. Tenant Owners can submit a reviewed module request from **Tenant Modules**. Pending requests are visible under **Platform → Module Requests**.
- Access is checked in backend routes, role permissions, assigned module sets, subscription term, and tenant/branch scope. Reports Analysts can be assigned reporting data sources without permission to transact.
- Reports is a standalone product providing workspace event summaries even without Mobile Money; optional source adapters are separately authorized for every entitled operational module. Only authorized aggregate data is exported as spreadsheet-safe CSV.
- Independent Mobile Money has its own monthly recording quota; renewal preserves its current quota generation. Providers, settlement and actual billing are disabled until validated integrations exist.
- Module revocation contracts existing staff/invitation assignments in the same database transaction and prevents implicit reauthorization on later renewal.
- After `npm ci`, run `npm run check`, `npm test`, `npm run catalog:publish -- --apply` (first publication of Modular Workspace), `npm run module:integration`, and `npm run release:gate`. The integration tests require a localhost MongoDB replica set and are forbidden on production/remote databases.
- Review `docs/INDEPENDENT_MODULES_V1_13.md` before upgrading.

## v1.17 — Banking requests (provider execution remains disabled)

Banking now operates independently from Mobile Money, Money Transfer and Operations Reports. A tenant with an active `banking` entitlement and an assigned Banking role can manage masked bank-reference records, create internal deposit/withdrawal/transfer *requests*, obtain independent decisions and review history. Operations Reports adds Banking only when both source and report subscriptions and user assignments are authorized. No bank account number, bank balance, deposit, withdrawal, transfer or settlement is verified by these internal records. See [Banking module release guide](../../docs/BANKING_MODULE_V1_17.md) and `CHANGELOG_BANKING_V1_17.md`.

## v1.19 — Advanced Analytics

Independent Advanced Analytics is now available with its own grant, MFA-protected Analytics Analyst role, aggregate source assignments, 7/14/30 completed-day comparisons, workspace trends and safe CSV export. Reports remains independently subscribable; neither product grants access to the other's routes. `npm run analytics:integration` verifies the scratch-database workflow. See [the v1.19 release guide](../../docs/ADVANCED_ANALYTICS_V1_19.md). This read-only operational intelligence is not a profit or settlement engine.

## v1.20 — Independent Approval Workflows

Approval Workflows now provides standalone, tenant- and branch-scoped internal business requests, immutable versioned policies, multi-stage independent approvals, cancellation, expiry, MFA for Approval Officers, audit history and optional aggregate reporting. This add-on is independent of all financial modules and **never executes a transfer, ledger reversal, payment or subscription change**. The required existing financial approvals are unaffected. Run `npm run approval:integration` against the isolated local replica set before authorizing any deployment, and review [the v1.20 guide](../../docs/APPROVAL_WORKFLOWS_V1_20.md).
