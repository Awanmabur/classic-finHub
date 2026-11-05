# ClassicFin Hub v1.12 — Shared transaction infrastructure and readiness controls

## Scope and decision

This release extends **v1.11** without replacing the approved interface, authentication, roles, tenant databases, commercial entitlements, outbox, backup, SEO, or existing Mobile Money internal review process. It implements a **reusable INTERNAL accounting/reconciliation orchestration layer** but **does not activate production financial movement**. The tenant dashboard's previously recorded Mobile Money operations are not silently converted to provider-confirmed or ledger-posted transactions; historical evidence would need explicit matching and controlled migration.

**Hard boundary:** A normalized gateway signature proves that a designated **internal** gateway signed the event for this tenant database. It does not prove the upstream provider's status, source account, settlement, or regulatory suitability. Before any real adapter calls this service, the adapter/gateway must verify the external provider's published signature scheme, transport authentication, transaction-status API, merchant ownership, currency, and final settlement statement independently. No production provider adapter is shipped in v1.12; no network-facing endpoint has been opened.

## Transaction lifecycle

1. **Register intent:** Only an eligible active tenant user on an active branch can register a unique `(sourceType, sourceRef)` and provider reference through the trusted internal service. Require a valid branch currency, approved chart accounts, exact positive integer minor units, matching total debit amount, balanced postings and successful audit write. An idempotent retry uses the original fingerprint; changed economics fail.
2. **Gateway evidence:** An authenticated gateway prepares an exact, tenant-database-bound canonical message with signed timestamp and event ID. The callback and statement require **distinct** 32-byte-or-stronger signing keys. Invalid signature, tenant, message shape or clock skew fail before the database is touched. Only sanitized economic metadata is stored (no raw customer PII or credentials).
3. **Inbox:** Evidence is append-only; a unique `(provider, kind, eventId)` index rejects duplicate or conflicting event IDs. Identical retries return the existing evidence. A callback may confirm or fail; a statement may only confirm. Settlement statements arriving before the callback are preserved and cannot prematurely post funds.
4. **Exception handling:** Unknown operations, mismatched reference/economics, duplicate settlement entries, unexpected state transitions and conflicting callbacks generate durable exception records instead of altering balances. A human reviewer other than the original initiator can document closure; closing an exception never creates a fictitious callback or settlement statement. Orphan evidence can only be closed by an MFA-enrolled Tenant Owner and cannot be attached to a guessed transaction.
5. **Reconciliation:** An active, MFA-enrolled Tenant Owner or branch-scoped Reconciliation Officer, independent from the initiator, must confirm two separately signed matching evidence types: callback and actual settlement-statement line. Reconciliation refuses unresolved exceptions, failed/unverified operations and pre-existing foreign ledger postings. All state changes and debit/credit postings are committed in one MongoDB replica-set transaction.
6. **Post-reconciliation:** Idempotent repeats return the existing transaction. The accounting journal is linked to its operation. Existing direct ledger reversal is **disabled** when the original journal came from a reconciled provider operation. A future provider reversal/refund adapter must first verify external correction evidence and independent approval; a local-only journal reversal cannot silently undo paid funds.
7. **Monitoring:** `financial:doctor` checks matching statement/callback evidence, linked journal integrity and open exceptions for a registered tenant/branch. It refuses to call a partial inspection a pass when there are over 500 operations. `reconciliationSummary` reports status counts and a bounded sample of aged confirmed callbacks without matching settlement evidence.

```text
Trust boundary: actual external provider
    -> (FUTURE) provider-specific verification, status query & statement validation
    -> tenant-bound, HMAC-authenticated internal gateway evidence
    -> durable, unique evidence inbox + exceptions
    -> matching callback + settlement statement
    -> MFA-enrolled independent reviewer
    -> atomic tenant ledger + operation state + audit
    -> read-only reconciliation/exception diagnostics
```

## Contracts and invariants

- Tenant identity is taken from the server-provided `conn.name`, not a URL/body-selected database. Supported tenant database names begin with `classicfin_`, including production's `classicfin_tenant_<slug>_db`.
- Currency and source types currently match existing supported ledger branches: **UGX/KES**, Mobile Money, Money Transfer, Banking and Forex. This is a shared infrastructure contract; the latter three modules remain disabled until real providers, policies and accounting mappings exist.
- Minor-unit arithmetic is integer/`BigInt` at validation boundaries and `Decimal128` in MongoDB; do not use floating-point money values. There is no automatic currency conversion or balance projection.
- Do not transform manually reviewed Mobile Money receipts into final settlements. The prior `pending_verification` records and the new financial operations are **separate** until a verified provider adapter explicitly links them.
- The gateway envelope's signed `issuedAt` indicates the gateway's *signing time*, not necessarily the provider transaction timestamp; maximum absolute signing-clock skew is 300 seconds. Sync clocks and protect gateway credentials in a secret manager.
- `FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX` and `FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX` are separate 64–128-hex-character secrets. Never use the values of `.env.example`; never reuse production signing keys in staging, tests, or client-side scripts. Rotate via a controlled signed-version migration before enabling a live provider; the current single-key contract does not yet support online multi-key rotation.
- These Mongoose schemas enforce append-only application usage, but any database principal with direct write privileges can bypass Mongoose middleware. Configure restricted database roles, external immutable audit/backup evidence and monitored privileged access.
- Do not authorize a user-facing reconciler from an ID parameter alone; the future controller must bind reviewer identity to authenticated server session and MFA verification and enforce module entitlements, subscription, branch and CSRF controls. There is **no** direct HTTP finance write endpoint in this release.
- The financial engine's `registerIntent`, `receiveEvidence` and `reconcileOperation` functions are only for trusted backend adapters and financial workflows, not public request handlers.

## Modified files

- `src/tenant/financial/schemas.js` — three new collections for financial operations, append-only gateway evidence and exceptions.
- `src/tenant/financial/transactionEngine.service.js` — validation, gateway signature verification, registration, conditional state transitions, reconciliation, exception closure and reporting.
- `src/tenant/models/index.js` — models and required unique indexes.
- `src/tenant/services/ledger.service.js` — internal transaction-session journaling and blocking provider-reconciled local reversals.
- `src/platform/services/infrastructureChecks.service.js` / `scripts/infra-doctor.js` — additional required indexes.
- `scripts/financial-integration.js` — exclusive random, disposable loopback database tests; signed gateway fixtures and recovery scenarios.
- `scripts/financial-doctor.js` — read-only registered-tenant integrity check.
- `tests/financial-lifecycle.test.js` and compatibility tests — non-database validation and security checks.
- `scripts/release-gate.js` — aborts if financial MongoDB integration or other required release checks fail.

## Reproducible staging verification

1. Back up and commit existing local changes; apply the **v1.11-to-v1.12** patch only if the working tree matches v1.11, or extract the full source into a new directory. Preserve `.env` and real database data.
2. On a machine with Node 22+, run:

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm audit --audit-level=moderate
```

3. Start a disposable single-node MongoDB replica set (Docker Desktop is supported), **never** a live tenant database:

```bash
npm run db:dev:up
npm run db:doctor
npm run indexes
npm run ledger:integration
npm run financial:integration
npm run release:gate
```

4. Inspect a registered staging tenant/branch (read-only):

```bash
npm run financial:doctor -- --tenant staging-tenant-slug --branch 507f1f77bcf86cd799439011
npm run ledger:doctor -- --tenant staging-tenant-slug --branch 507f1f77bcf86cd799439011
```

The `financial:integration` script explicitly rejects `NODE_ENV=production`, non-loopback URLs, authentication credentials, and multi-host URIs. It only creates random scratch databases with known guarded prefixes and drops those exact scratch databases. It does not call real provider APIs.

## Failure/recovery scenarios

| Scenario | Safe behavior |
| --- | --- |
| Duplicate signed callback | Same event digest returns the existing record; no double journal |
| Same event ID, different payload | Conflict, no overwriting previous evidence |
| Same provider transaction appearing twice in distinct settlement events | Durable duplicate-settlement exception; reviewer investigation required before posting |
| Statement before callback | Saved as evidence, no posting until matching callback and approval |
| Provider failure followed by success | Terminal conflict/exception; no automatic conversion to settled |
| Amount, currency, reference or provider mismatch | Append-only unmatched evidence and exception; no posting |
| Callback without statement | Remains provider-verified, not reconciled or journaled |
| Initiator attempts reconciliation | Rejected, even if actor has an elevated role |
| Reviewer outside branch or without MFA | Rejected before posting |
| Concurrent reconciliation | Transaction/index conflict; only one linked journal can commit |
| Journal posting fails | Mongo transaction rolls back state, posting and audit together |
| Gateway signing key unavailable | Evidence ingestion fails closed; no fallback verification |
| Local ledger reversal of reconciled provider funds | Blocked until provider-verified external reversal lifecycle exists |
| Tenant mismatch | Signature is bound to destination tenant database; wrong tenant fails |

## Production release gates — not optional

**Code implemented is not production signoff.** The following evidence is unavailable in the packaging environment and must be collected before enabling real money: (1) online npm advisory clearance and dependency review; (2) replica-set integration results, concurrent stress/soak and fault injection; (3) audited, provider-specific callback verification, source-of-truth payment status checks and authenticated settlement statement feed; (4) financial controller/session/role/plan permission integration for each completed module; (5) full recovery drill of tenant databases, encrypted offsite backups and infrastructure; (6) tracing, alerts, on-call and incident playbook for financial exceptions and reconciliation delays; (7) chart-of-accounts and fee/liability treatment reviewed by a qualified accounting professional; (8) payment-provider/regulatory onboarding, rate limits, business agreements and safeguarding where required; (9) live staging deployment, backward-compatible database migration, load testing, rollback evidence and independent security review; (10) provider correction/refund and key-rotation lifecycles.

There is no claim of a live provider being connected, a customer balance being posted, or the complete product being ready for real funds in v1.12. `REAL_MONEY_ENABLED` remains disabled. **Module development can start on this contract**, but each module must implement and independently verify its own full external integration and user workflow before release.
