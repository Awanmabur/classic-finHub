# ClassicFin Hub v1.19 — Independent Advanced Analytics

## Scope and architectural decision

Advanced Analytics (`analytics`) is an independently subscribable, read-only module. It **does not** require an Operations Reports (`reports`) subscription. It **does** reuse the exact same aggregate reporting adapters in `src/tenant/reporting/registry.js`, so there is no second calculation engine producing competing numbers.

The Analytics product computes **record counts and period-over-period operational activity**. It does not claim profit, fees earned, revenue recognized, settled balances, liquidity, verified payments, or cash positions. Those metrics require reconciled provider evidence and financial accounting; they must not be invented from request or audit counts. The existing `analyticsSnapshot.job` is intentionally not scheduled. On-demand analytics requires no background job and does not persist a shadow copy of another tenant's operational records.

### End-to-end request path

1. Tenant buys or is granted the independent `analytics` module through the existing audited versioned module-grant workflow (or receives it under a published plan).
2. Tenant Owner invites an **Analytics Analyst** with a branch and the `analytics` module, optionally assigning operational source modules. The Analyst has MFA and no rights to initiate, approve, pay out, or settle transactions.
3. Login remains email and password, followed by MFA for privileged Analyst roles. The workspace resolves automatically.
4. `/tenant/analytics` is protected by tenant authentication, active subscription, user module assignment, `analytics.view` permission and a database-coordinated request budget.
5. The analytics service resolves the user's branch scope and only enumerates adapters for independently subscribed **and** individually assigned source modules. Workspace activity always works without additional modules.
6. Queries compare the last **7, 14, or 30 fully completed UTC days** to the equally sized preceding period. They read only aggregate results, never raw sender, account or customer details. Workbook-formula-safe CSV export requires `analytics.export`.
7. View uses the existing dashboard layout, stylesheet, responsive cards and tables; no new theme or global CSS was introduced. Private responses are `no-store`, and the dashboard already has a `noindex,nofollow` directive.

### Product independence

| Subscription | Permitted result |
| --- | --- |
| Analytics only | Workspace audit-event comparison and daily trend, scoped by tenant/branch |
| Operations Reports only | Operations Reports hub; no Advanced Analytics access |
| Analytics + Forex | Forex quotation aggregates **only** for users also explicitly assigned Forex |
| Analytics + Mobile Money | Mobile Money and Cash Shift aggregates for authorized branches |
| Analytics + Banking or Money Transfer | Respective request aggregates for authorized branches |
| Analytics + Reports | Both products independently available; staff can be assigned either or both |

**No role escalation:** an Analytics Analyst assigned `forex` does not gain `forex.quotes.create`, `forex.rate_review`, or any other operational action. Owner permissions still require effective tenant entitlements.

### Guardrails

- Fail closed if the independent module grant expires, is revoked, the tenant is suspended, the staff user lacks an explicit module assignment, or the requested source is unavailable.
- Branch scope is derived from authenticated staff identity, not client-provided branch IDs. Non-owner users without a valid branch cannot query.
- Max comparison window: 30 complete days (60 days of aggregate reads); no arbitrary unbounded date query.
- Max 5,000 aggregate groups per adapter read; UI displays at most 100 breakdown rows per source and labels this limit. No source is silently presented as a full detail export.
- Rate limits: **20 user queries/minute, 120 tenant queries/minute**, using shared MongoDB throttles to work across multiple web instances.
- CSV contains aggregate labels, periods and counts, with spreadsheet-formula injection prevention; no customer names, phone numbers or bank account references.
- Workspace audit events and module record counts can overlap. They are **never added together** into a purported financial or operational grand total.
- No floating-point currency total is calculated. If a module's provider, ledger or reconciliation controls have not verified a record, Analytics does not relabel it settled.

### Source code and roles

- `src/tenant/services/analytics.service.js` — authorization, ranges, aggregate comparisons, workspace trend, safe CSV.
- `src/tenant/controllers/analytics.controller.js` — private dashboard and CSV controllers.
- `src/tenant/routes/analytics.routes.js` — independent permission- and rate-guarded routes.
- `src/config/roles.js`, `src/tenant/models/index.js`, `src/tenant/services/moduleAccess.service.js` — role, MFA, explicit module assignment.
- `src/services/menu.service.js`, `src/views/tenant/analytics/index.ejs` — approved navigation and dashboard style.
- `src/data/store.js` — catalog activation and accurate product description.
- `tests/advanced-analytics.test.js` — core role, source, date, scoping, injection and view regressions.
- `scripts/analytics-integration.js` — destructive **scratch-only** MongoDB test, restricted to local loopback replica sets.
- `scripts/release-gate.js` — Analytics integration added to mandatory local gate.

## Verification and deployment

On the exact v1.18 repository (commit or back up your local modifications first):

```bash
git status --short
git apply --check classicfin-v1.18-to-v1.19.patch
git apply classicfin-v1.18-to-v1.19.patch
npm ci
npm run check
npm test
npm run perf:assets
npm run perf:smoke
npm audit --audit-level=moderate
```

With Docker Desktop running on a **non-production** local machine and an isolated replica set:

```bash
npm run db:dev:up
npm run indexes
npm run analytics:integration
npm run release:gate
```

The integration test creates two temporary tenant databases and removes them, verifies branch scope, tenant isolation, independent Analytics vs Reports, subscription absence, historical comparison, optional Forex source, and CSV. It refuses non-loopback or production database addresses. **Do not point it at production data.**

### Release gate status in this build environment

- 195/195 source automated tests: **PASS**.
- 429 JavaScript and EJS source validation: **PASS**.
- Public marketing image budgets: **PASS**.
- 48-request local public HTTP smoke: **PASS** (not production load testing).
- npm security audit: **UNVERIFIED**, registry DNS request failed with `EAI_AGAIN`.
- MongoDB replica-set integration: **UNVERIFIED**, no local MongoDB service was available here.
- Live Contabo deployment, staging role/branch browser walkthrough, data scale and backup recovery: **NOT PERFORMED**.

A working source module is not a certified financial-production deployment. Do not disable required safeguards or mark unresolved release gates green. No API credentials are needed for this module. For real income/profit analytics, first establish independently verifiable settlement, fees, expenses and ledger reconciliation.
