# v1.23 — Cross-module integration and release evidence

## Architecture preserved

The modular monolith, platform and tenant databases, global identity directory,
branch authorizations, role-specific EJS dashboards, subscription snapshots,
standalone module grants, financial ledger and event workers remain intact.
The `public/css/dashboard.css` asset is unchanged.

## Changes and guarantees

### Branch-scoped physical cash reports

`CashSession.branchId` is a MongoDB ObjectId. Aggregation does not cast
strings as Mongoose find() does. The report now casts a validated branch ID
to ObjectId before matching. A user without an authorized branch remains
blocked upstream; reporting cannot be used to select an arbitrary branch.

### Base plan vs standalone entitlements

An independent module grant remains in effect during an ordinary base-plan
downgrade if its term is still valid. Only truly lost modules are removed
from user and pending-invitation assignments. Workspace capacity is the
maximum of the next base plan and active standalone allocations. A past-due
tenant being reactivated is evaluated using its prospective active state.
All these controls execute inside the existing auditable MongoDB subscription
transaction, including auth-version invalidation for genuinely lost modules.

### Cross-module reporting accuracy

Audit events, financial requests and shift records can describe overlapping
operations. The Reports dashboard therefore shows a count only when a single
source is selected. For multiple sources, it displays per-source counts
without summing incomparable records or claiming profit or settlement.

### Tenant Overview performance

After index readiness, independent, authorized module summary reads use
`Promise.all`. This reduces serialized query latency without sharing data
between tenants. Per-module query limits are unchanged. Monitor database
query load and pool utilization under production concurrency.

## Validation on your Windows or staging environment

1. Back up the repository and database; apply the patch to the **exact v1.22**
   source and inspect `git diff`.
2. Run `npm ci`, `npm audit --audit-level=moderate`, `npm run check`,
   `npm test`, `npm run perf:assets`.
3. Start the isolated test replica set: `npm run db:dev:up`, then run
   `npm run indexes` and `npm run release:gate`.
4. Exercise accounts: Super Admin, Tenant Owner, Branch Manager, Auditor,
   Mobile Money Operator, Reports Analyst, and a standalone-module-only tenant.
5. Run reports for a branch that has actual cash shifts, then compare with
   the same data viewed by its Tenant Owner. Verify that other branch data is
   absent and that selecting all sources does not invent a combined count.
6. With two independent grants active, downgrade the base plan in staging.
   Confirm entitled modules remain, truly revoked modules disappear,
   sessions for affected staff are revoked, and seat/branch limits remain valid.
7. Exercise the same scenario with a past-due tenant being reactivated.
8. Monitor p95 dashboard response time, DB pool utilization and read count
   under realistic concurrency, along with deployment rollback and restore.

## Release gates

Do not deploy for real-money operations without a passing real replica-set
integration test, npm vulnerability audit, live role isolation tests, backup
restore drill, monitoring alerts, and provider-specific reconciliation.
All external provider execution remains gated separately.
