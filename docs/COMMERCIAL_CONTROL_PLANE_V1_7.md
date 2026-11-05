# ClassicFin Hub v1.7 — Commercial Control Plane and Release Evidence

**Scope:** This release completes a **manual, audited commercial entitlement workflow** and makes it authoritative for the functioning tenant modules. It does **not** implement collection of subscription payments, invoicing, tax, automatic billing, external settlements, or live banking/forex. This distinction is a customer-safety and regulatory requirement, not a design omission to hide.

## Design and data ownership

- Keep the existing Express/EJS modular monolith, login, private tenant databases, MFA, staff/branch restrictions, and approved dashboard CSS. Do not create a second business-access authority in the frontend.
- `PlanVersion` is a persisted immutable *published* catalogue revision, unique by `(code, version)`. Operators publish an initial catalogue with `npm run catalog:publish -- --apply`, or publish the next version from a reviewed local JSON file. Publication and its audit entry are in a transaction. A changed plan must get a new version; never edit a published record in place.
- `Tenant.subscription` is the **one authoritative current access snapshot**: plan code/version, frozen limits, modules, source, term, status and generation. An existing tenant keeps its agreed snapshot even when a newer catalogue revision is published. Platform `Tenant.plan` and `enabledModules` are retained for compatibility and updated atomically with the snapshot.
- Only an authenticated **Super Admin after MFA** may issue an audited `manual_admin_grant` or revoke an entitlement. This is a commercial support grant, **not evidence of payment**. All writes use CSRF-protected platform routes, validated input, MongoDB transactions and platform audit.
- Expired, revoked, unassigned or suspended subscriptions are denied at request boundaries. Normal GET navigation routes to the billing explanation; write requests fail with an explicit error. Billing is available for the Tenant Owner without granting financial module access. A tenant cannot select a different tenant or plan by altering a URL/header.
- Branch creation/restoration and staff invitation/restoration use the **snapshot's actual limits**, not hard-coded marketing prices. Module access requires an active subscription, plan inclusion, platform-enabled module runtime, tenant inclusion, the user's role permissions, and individual module assignment.
- A downgrade contracts staff and outstanding invitation module assignments in the **same cross-database transaction** as the tenant grant; affected staff `authVersion` is incremented, invalidating old sessions. An unresolved internal Mobile Money review blocks removal of that module. An upgrade never silently re-enables previously removed staff grants.
- `UsageCounter` records unique `(tenantId, generation, UTC-month, metric)` quantities. The Mobile Money record workflow atomically reserves one `mobile_money_records` unit in the same MongoDB transaction as the immutable operation and audit event. Retries on the same idempotency key do not consume another unit. Conditional increments and the unique index prevent exceeding the grant. An aborted transaction refunds its reservation.
- Renewal on the **same published plan** extends its end date and keeps the same usage generation. Changing to another published plan or reactivating a revoked subscription starts a new generation; all such changes require an audited Super Admin action. A single subscription term cannot extend beyond 366 days from the grant date.

## Where the UI connects

| Role | Verified workflow in source | Permission boundary |
|---|---|---|
| Super Admin | Platform dashboard → Plans (persisted versions), Subscriptions listing, Tenant detail → audited grant/renew/revoke | Requires real platform MFA and server `*` permission |
| Tenant Owner | Tenant dashboard → Billing & Plan → current term, seat/branch limits and usage counters | Read-only; cannot modify commercial entitlements |
| Branch Manager | Own-branch dashboard, staff and permitted module navigation | No plan changes; branch and module limits enforced in backend |
| Operator | Mobile Money record with idempotency → branch record + audit + monthly quota | Recording only, never provider settlement |
| Reviewer/Auditor | Independent review, read-only audit/report access as permitted | Cannot create a provider payment or change a tenant's plan |

## New commands

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up           # isolated localhost MongoDB replica set, Docker Desktop required
npm run indexes             # prerequisite indexes; never assume an app restart repairs old data
npm run catalog:publish     # read-only preview of first published versions
npm run catalog:publish -- --apply
npm run commercial:migrate  # read-only old-tenant assessment; reports legacy active tenants
npm run commercial:migrate -- --apply   # AFTER verified backup, only reliable old trials
npm run infra:doctor        # read-only tenant seat/branch/entitlement/index consistency
npm run commercial:integration # disposable scratch tenant; localhost ONLY
npm run release:gate        # local DB integration + online npm security audit, fails closed
```

**Existing tenant migration:** Take a verified backup and stage a rehearsal. **DO NOT** infer a paid term from an old `status:active`. The migration only snapshots existing trials that have reliable start/end dates and fit the plan's limits. Active or ambiguous legacy tenants remain blocked from financial modules until the platform administrator grants a dated manual subscription after reviewing the agreement. An exit code `2` from migration signals tenants requiring manual review; do not suppress it. Older staff must still have explicit branches and module assignments. `infra:doctor` will surface inconsistencies and never silently repair them.

**Plan revisions:** The version publication command accepts a local reviewed JSON file with `code,name,description,currency,priceMonthlyMinor,priceYearlyMinor,trialMonths,modules,limits`. Currency is currently USD; amounts are integer cents. The plan code must be a supported plan from the initial catalogue. An example revised plan file (illustrative only):

```json
{
  "code": "agent", "name": "Agent Plan", "description": "Reviewed version for agent operations, subject to actual enabled modules.",
  "currency": "USD", "priceMonthlyMinor": 14900, "priceYearlyMinor": 149000,
  "trialMonths": 1, "modules": ["money_transfer", "mobile_money", "notifications"],
  "limits": {"users": 12, "branches": 3, "transactionsPerMonth": 5000, "smsPerMonth": 1000, "storageMb": 3000}
}
```

Preview and publish only after the published-v1 catalogue exists:

```bash
npm run catalog:publish -- --file=docs/plan-next-version.json --reason='Approved commercial revision with legal review and pricing signoff'
npm run catalog:publish -- --apply --file=docs/plan-next-version.json --reason='Approved commercial revision with legal review and pricing signoff'
```

`docs/plan-next-version.json` is an **illustrative filename**; create/review your actual plan file deliberately. A publication creates a new version; it does **not** change any existing customer's current subscription or charge a payment method.

## Confirmation gates before any live production release

1. **Clean dependency installation and advisory gate:** `npm ci`, `npm audit --audit-level=moderate`, `npm run check`, `npm test`, `npm run perf:assets` pass using the actual checked-in lockfile. Do not run `npm audit fix --force` blindly. The source runner could not reach the npm registry, so advisory clearance was **not verified here**.
2. **Real MongoDB replica-set integration:** `npm run catalog:publish -- --apply`, `npm run commercial:integration`, `npm run admin:integration`, `npm run auth:integration`, `npm run review:integration`, `npm run db:integration`, and `npm run infra:doctor` pass against isolated LOCAL/STAGING data. Integration scripts deliberately reject remote/production MongoDB. **No MongoDB instance was available in this build environment.**
3. **Staging deployment and rollback:** stage the migration and every legacy tenant, test privilege revocation and quota races, verify production-like network/TLS/proxy secrets, exercise an actual app rollback and a database restore from encrypted off-host backups.
4. **Performance and resilience:** run multi-tenant branch/operator load and soak tests, real browser Core Web Vitals, DB query profiling, an outage drill, alert delivery and capacity checks. Local HTTP smoke tests are not evidence of live p95 latency.
5. **Payment and financial compliance:** there is deliberately no automatic subscription payment, invoice collection, provider webhook or ledger settlement. Before enabling them, implement verified signatures, idempotent callbacks, durable outbox/worker, double-entry ledger, reconciliation, reversal/refund paths, tax/invoice controls, charge disputes and licensed partner/legal requirements. Do not consider `recorded` as `paid` or `settled`.
6. **SEO and AI discovery:** public-only canonicals, sitemap, robots and `llms.txt` remain. Private dashboards must stay noindex and unauthorized. A `llms.txt` file does not guarantee AI inclusion or ranking. Verify real crawls and Search Console indexing only after a production deployment.

## Important limitations

- Admin-manual grants are a **complete bounded workflow**, but **automated commercial billing is not implemented**. Pricing remains indicative until a commercial agreement and provider workflow are in place.
- Published plan version immutability is enforced at the application/API layer and with source hashes; it is not WORM or cryptographic tamper-evidence against privileged database administrators.
- Per-tenant logic is on logical MongoDB databases, still using the application's shared DB credential. Independent tenants may need separate cluster/credentials for higher compliance isolation.
- Enterprise-grade zero-downtime multi-replica migrations, backups/restore, edge rate limiting, off-box audit and alerting, provider connections, and live payment settlement are release blockers. Do not report 100% security or production certification without external evidence.
- No Git remote push or production deployment is included in this package.
