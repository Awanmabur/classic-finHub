# ClassicFin Hub v1.6 — infrastructure-first architecture and release gates

**Project goal:** a modular financial-operations SaaS with separate platform, tenant and branch authorization. This release strengthens an existing application, not a rewrite. The approved dashboard stylesheet and two-field email/password sign-in were retained. Privileged users complete a separate MFA challenge.

## Architecture decision

Keep one modular Node.js/Express deployable, with separately owned modules, a dedicated platform database, logical tenant databases from validated persisted slugs, a bounded shared MongoDB connection pool, and MongoDB sessions for cross-database atomic administration. No microservices yet: there is no measured load or team boundary to justify cross-service distributed transaction overhead. Add a queue/worker and immutable outbox before provider webhooks and asynchronous settlement. Keep reconciled monetary balances on a double-entry ledger, never derive balances from unverified operational records.

**Request path**: Reverse proxy/TLS → HTTP/security middleware → session → global account identity lookup → MFA if privileged → tenant status → tenant-user role/branch/permissions → subscription/module entitlements → application service → MongoDB transaction → tenant/platform audit → response. Enforcement is on the server; hiding a sidebar item is not authorization.

**Isolation model**: Platform operations use platform credentials and database. Tenant requests resolve a database from the authenticated tenant record, not user headers/query strings. Branch staff are filtered by the branch from their authenticated account. The model is *logical* MongoDB isolation using the application's shared database credential, **not** separate per-tenant database credentials or hard infrastructure isolation. Stronger compliance/enterprise isolation may require separately provisioned DB users and/or clusters.

## Release v1.6 changes

- Fixed an incorrect branch-model require path which could cause HTTP 500 after branch staff signed in.
- Denied privileged access to staff without an assigned **active** branch; legacy staff without explicit module assignments now get **no automatic module grant**. Migrate and explicitly grant roles/branches/modules before rollout.
- Added server-side Branch Manager delegation, limited to Mobile Money Operators and Viewers in **their own branch**. Staff invite, account edit, disable, re-enable and invitation revocation query predicates enforce the same scope. Managers cannot assign Reconciliation Officers, Auditors, Branch Managers or Tenant Owners, cannot grant modules they lack, and cannot edit other branches.
- Tightened seat-count rollback on staff disable/invite cancellation, incremented authVersion on disable, filtered all branch-specific administration UI and Mobile Money branch selectors, and preserved existing dashboard stylesheet.
- Removed in-memory demo tenants, fake balances, invoices, payment records, and fake transaction mutation helpers from the runtime catalogue. Preserved an immutable public **plan/module metadata** catalogue. Previously unused mutable module toggles and fake module requests now fail closed.
- Removed the unused mock SMS helper that logged full numbers and message contents. It now fails closed; storage paths validate tenant/area names.
- Added `npm run infra:doctor` (read-only tenant consistency + critical unique-index scan), and `npm run release:gate` (automated staging checks including online npm audit). The diagnostic never silently repairs tenant state or logs customer details.

## Verified role/dashboard capabilities

| Role | Effective v1.6 functionality | Deliberate restrictions/gaps |
| --- | --- | --- |
| Super Admin | MFA, overview from real tenant and appointment records, tenant provisioning/status/profile edits, platform audit, catalogue visibility | No complete platform-staff delegation, subscription lifecycle, payment reconciliation or catalogue publishing |
| Tenant Owner | MFA, tenant overview, branch create/edit/archive/restore, all staff and module assignments, tenant audit, Mobile Money record/review and reports | Billing page read-only, cash/ledger/settlement not enabled |
| Branch Manager | MFA, branch overview, own-branch directory and invitation flows, manage Operators/Viewers, view own-branch reports and audit | Cannot create branches, change tenant billing, grant elevated roles, change other branches, or review settlements |
| Reconciliation Officer | MFA, branch-scoped independent internal review, reports and audit | Cannot review own record or certify provider settlement |
| Mobile Money Operator | Role- and branch-bound recording and own operational history | No provider settlement, actual balance transfers or review privilege |
| Auditor | MFA, tenant audit, reports, read-only Mobile Money operations | No write/approval access |
| Viewer | Role-scoped Overview and assigned-module read-only access | No writes or extra branch visibility |

The dashboards are source-code and render-tested; **real MongoDB authenticated browser flows still require release evidence**. A role's permissions must be checked on every endpoint and background job.

## Release gate — evidence required before live tenant access

1. **Code**: `npm ci`, `npm run check`, `npm test`, `npm run perf:assets` pass in a clean workspace. Confirm a fresh online `npm audit --audit-level=moderate` passes; the registry was not accessible in this build environment.
2. **Staging MongoDB**: use an isolated localhost replica set, run `npm run release:gate` to exercise create/invite/login/MFA, role and branch isolation, transactional rollback, stale-session rejection, review concurrency, and indexes. The integration scripts intentionally refuse production or remote databases.
3. **Migrations**: back up the old database before upgrade; run identity migration dry-run, fill missing staff branch/module assignments explicitly, check `infra:doctor`, and reconcile recorded branchCount/seatsReserved **with audited corrections**. Do not infer historical financial branches from unknown metadata.
4. **Configuration**: non-default session and MFA secrets, HTTPS APP_URL, correct trusted proxy hops, MongoDB authentication and TLS, limited credentials, private network, session store, verified mail sender, WAF and distributed rate limiting, secrets rotation and zero secrets in Git or images.
5. **Reliability**: encrypted off-host backups with actual point-in-time restoration, tested RPO/RTO, capacity and concurrency load/soak tests, alerting, on-call, rollback of image/config/index migrations, incident simulation. The existing `backup.job.js` is intentionally nonfunctional and must not be counted as backup protection.
6. **Commercial platform**: versioned paid plans, invoice/tax/payment lifecycle, webhook verification/replay, renewal/past-due/suspension/recovery, persisted usage quotas, cost and analytics instrumentation, support tooling and auditable upgrades/downgrades.
7. **Module expansion**: double-entry ledger, outbox and provider reconciliation, idempotent callbacks, rejects/reversals, provider-down chaos tests, legal/licensed-partner readiness before real funds. Disabled modules stay disabled until verified end-to-end.
8. **SEO and performance**: verify canonical host, sitemap, `robots.txt`, `llms.txt` and public-only structured data in staging and production. Do not index tenant/admin paths. Collect real p75 Core Web Vitals, DB query p95, application error rates, cache hit rates and load profiles. Local asset/HTTP smoke tests do not replace these.

## Commands

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up
npm run infra:doctor             # read-only diagnostics
npm run release:gate            # only isolated LOCAL/STAGING replica set; writes disposable data
npm run dev:local
```

`release:gate` will stop with failure when MongoDB, audit registry or required integration checks are unavailable; do **not** treat that failure as an optional warning or bypass it with `npm audit fix --force`.

## Risks explicitly not resolved by this package

- Public pricing is **static catalogue content**, not a published versioned billing and entitlements service. Transactions-per-month metering and subscription webhooks are not enforced yet.
- The general HTTP rate limiter is process-local; use shared infrastructure for scaled replicas. Sensitive sign-in and financial action throttles already use MongoDB, but overall DDoS controls need a real edge policy.
- Audit models are write-restricted by application logic, not cryptographically tamper-evident/WORM storage; off-box shipping and tamper-evidence remain to be built.
- No local MongoDB, Docker, external provider or public npm registry was available to run the real infrastructure/financial integration and security-release gates here. Source-test passing does not mean an approved production deployment.

**Next engineering milestone:** finish the *commercial control plane* (persisted plans, subscription state, usage counters, billing event/webhook lifecycle, platform staff roles) and prove it on real staging MongoDB. Only after that finalize ledger/outbox/provider processing and enable individual financial modules. Avoid microservices before demonstrated scale demands them.
