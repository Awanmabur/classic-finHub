# ClassicFin Hub v1.23 — Cross-module audit fixes

## Corrected

- Branch-restricted cash-shift reporting now casts its MongoDB aggregation
  branch filter to `ObjectId`, matching the stored `CashSession.branchId` type.
- Manual base-plan transitions preserve staff assignments for modules with an
  active, independent subscription.
- Base-plan capacity checks include concurrently active standalone module seat
  and branch allowances; an administratively renewed past-due tenant is
  evaluated against the entitlements it will have once active.
- Operations Reports no longer show a fabricated combined count when audit
  events and module records overlap. Selecting one source retains a count.
- The Tenant Overview executes independent authorized module reads in parallel,
  retaining the same role, branch and module checks.

## Verification and unresolved gates

- New isolated contract tests check independent subscriptions, aggregation
  branch types and overlapping-report count semantics.
- JavaScript syntax and public marketing asset budgets pass in this environment.
- **Not executed here:** full dependency-backed test suite, EJS compilation,
  real replica-set integration, npm audit, deployed browser tests and
  Contabo staging/production verification.
- No provider settlement functionality was enabled.
