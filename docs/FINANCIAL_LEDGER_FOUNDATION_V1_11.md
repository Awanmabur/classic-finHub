# ClassicFin Hub v1.11 — Financial ledger foundation and release controls

## Scope and production status

This release establishes an **internal-only** tenant accounting foundation. It does **not** activate transfers, Mobile Money provider settlement, bank disbursements, customer balances, automatic FX conversion, or a public financial posting endpoint. The existing approved dashboard, branding, responsive layout, SEO configuration, tenant onboarding, role-based sign-in and financial operational recording are preserved.

**Do not post real provider events until the dedicated provider verification, lifecycle and reconciliation module is completed and independently tested.** Setting `REAL_MONEY_ENABLED=true` still causes startup to fail. Customer-facing Mobile Money records still remain `pending_verification` after internal review; they are not automatically journaled.

## Structure

- `src/tenant/ledger/schemas.js` — separate append-only models for `LedgerAccountV2`, `LedgerJournalV2`, and `LedgerPostingV2`. The old banking `Account` and legacy `LedgerEntry` placeholders are **not** accounting source-of-truth.
- `src/tenant/services/ledger.service.js` — exact integer minor-unit validation, balanced journals, cross-branch/currency checks, strict source idempotency, atomic posting with the audit event, two-person reversals, trial balance and record-integrity inspection. Existing `postEntry()` remains explicitly disabled to prevent accidental use of unverified flows.
- `src/tenant/models/index.js` — registers and builds financial uniqueness indexes before tenant operations.
- `src/tenant/services/branch.service.js` — refuses to archive a branch once ledger history exists. Posting and archiving both write the branch revision in the same MongoDB transaction, preventing a lifecycle race. This is intentionally conservative; high-volume deployments will require a branch lifecycle gate designed to avoid this write hotspot.
- `scripts/ledger-integration.js` — tests against two **temporary local** MongoDB databases only, with automatic cleanup: posting, retries, changed-input rejection, rollback, two-person reversal, equality, audits and tenant isolation.
- `scripts/ledger-doctor.js` — read-only integrity and trial-balance verification of one registered tenant branch, limited to 2,000 journals and 500 accounts. Exceeding bounds aborts instead of claiming a partial check is complete.
- `scripts/release-gate.js` — now includes `ledger-integration.js` before release approval.

## Invariants

1. Each journal belongs to a single tenant database, branch and currency. There are currently only **UGX and KES** ledger currencies, matching supported branch currencies. FX conversion is **not** implemented.
2. Each posting records strictly positive integer minor units (`Decimal128` storage; `BigInt` validation). Floating-point amounts, negative amounts, duplicate account lines and zero amounts are rejected.
3. Every journal has at least two and at most 50 unique account postings and exactly equal total debits and credits. No cross-branch or cross-currency entries are allowed.
4. Unique `(sourceType, sourceRef)` identifies each external origin within one tenant. An identical retry returns the existing journal. A reused reference with different economics raises a 409 and cannot produce an additional posting.
5. A journal, its postings, and an audit event are created in **one MongoDB replica-set transaction**. Any failed validation or database write aborts the complete transaction.
6. The original journal is never edited or deleted by application services. A reversal creates another balanced journal with opposite sides and a unique `reverses` link; a second reversal is refused. The reversal approver is an active, MFA-enrolled Tenant Owner or branch-scoped Reconciliation Officer, different from the requester and the original poster. The requester must be an active tenant user from that branch or its owner.
7. Account creation is restricted to MFA-enrolled Tenant Owners, with a transactionally recorded audit event.
8. Trial balance is derived from postings, not mutable account balances. The branch aggregate must balance, and the read-only doctor verifies each covered journal fingerprint and reversal relationship.
9. Ledger models have immutable fields, strict schemas and Mongoose update/delete guards. **Database privileges and offsite audit/backup controls are still mandatory**: any MongoDB principal with direct write privileges can bypass Mongoose safeguards. SHA-256 fingerprints are tamper-evidence checks, not independent cryptographic proof against a privileged database attacker.

## Upgrade and local verification

Use this release only on a repository matching **v1.10**. Preserve existing tenant data, `.env`, backups and secrets. No ledger data migration is required because the old ledger service did not post live financial records; however, do not automatically import legacy demo ledger records. Take a verified database backup before creating new indexes.

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run indexes
npm run ledger:integration
npm run release:gate
```

The integration script **refuses** `NODE_ENV=production`, remote databases, multi-host URLs and credentialed URLs. Start a disposable local MongoDB replica set first, for example with `npm run db:dev:up` when Docker Desktop is available. The script creates uniquely named scratch databases and drops only those databases. Never run the integration suite against customer databases.

To inspect one real *read-only* tenant branch after verified indexes:

```bash
npm run ledger:doctor -- --tenant your-registered-tenant-slug --branch 507f1f77bcf86cd799439011
```

This doctor does not reconcile provider balances, detect omitted external transactions, perform settlement, or replace a financial audit. Audit output contains only tenant slug, branch ID, counts and a boolean result; it does not export customer data.

## Release blockers — do not waive

- A successful real replica-set `ledger:integration` run, along with existing auth, admin, commercial and outbox integration tests.
- Online `npm audit --audit-level=moderate`, followed by review of any advisory requiring breaking dependency upgrades.
- Independent database permissions test and recovery drill, including encrypted offsite backup restoration and retention evidence.
- Provider authentication/signature verification, idempotent callback capture, transaction lifecycle, provider settlement confirmation, exception queues, reconciliation and late/out-of-order callback handling.
- Separate financial accounting review of the chart of accounts, liability treatment, clearing and fee postings, overdraft limits, safeguarding and currency rounding.
- Concurrent-load test for branch revision contention (current write synchronization prioritizes safety over maximum throughput), resilience/soak tests, staged rollout and rollback drill.
- Customer balance projection/snapshots designed with an immutable journal and replay-safe reconciliation as usage grows. `trialBalance()` intentionally does not write mutable balances.
- Continuous monitoring, audit export, backup restoration, incident response and live operational signoff before enabling any provider money movement.

**Status:** Source checks can pass independently of an actual database. In the authoring environment the MongoDB integration test could not connect (`ECONNREFUSED`), and the npm advisory endpoint returned `EAI_AGAIN`. Neither gate is represented as passed.
