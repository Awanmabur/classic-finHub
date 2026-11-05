# ClassicFin Hub v1.15 — Mobile Money physical-cash controls

## Purpose and financial boundary

This release completes a *bounded, internal* operational workflow: a branch operator records physical cash opening counts, an independent supervisor verifies them, cash-in/out entries are linked to that operator's shift, records are reviewed or internally voided, cash is counted again at shift close, and a second person approves or disputes the final count. It **does not** create electronic float, confirm provider settlement, settle a customer transfer, generate invoices, or move funds. Every acknowledgement is explicitly labeled **not proof of payment**.

A complete financial-service launch additionally requires the actual provider adapters, authenticated provider callbacks and settlement statements, reconciled ledger postings, real infrastructure testing, and regulatory approval where applicable. No dummy provider success is returned.

## Operational workflow

1. An authorized Tenant Owner or Mobile Money Operator requests a new cash shift with an opening physical cash count. A unique partial index prevents a second active shift for the same branch/operator. Shift status is `pending_open`.
2. An independent Tenant Owner, Branch Manager or Reconciliation Officer approves the opening count, recording the evidence, or rejects it. Rejected requests remain in history and cannot take transactions. The operator cannot verify their own count.
3. Once `open`, each new Mobile Money internal recording must attach to that operator's exact branch/currency cash shift in the same MongoDB transaction as the record, quota reservation and audit event. The cash estimate is provisional; physical cash-in is positive and cash-out negative. Fees are **not** added because fee custody has not been proven. A negative provisional cash position is refused.
4. Independent internal review or an audited, two-person void must finish for every shift record before the originating operator can submit the closing physical count. Corrections after `submitted` or `approved` are blocked until a supervisor disputes a submitted count; after approval no direct mutation is allowed. Older pre-v1.15 records are left historical/unassigned, not guessed into a new shift.
5. Submission computes expected closing cash using integer minor units, verifies record count and **re-aggregates original records** to detect position drift, and stores the declared count and variance. Every new submission is appended to an immutable-in-workflow count-history array.
6. A different authorized reviewer approves/disputes the submitted count. Branch Managers may approve exact matches or dispute mismatches; nonzero-variance approval requires a Tenant Owner or Reconciliation Officer. Approved shifts can never be reopened. A disputed shift returns to the original operator for investigation and another submission.
7. Authorized users can inspect paginated, branch-restricted shift history and print a read-only, scoped operational acknowledgement. It is not a provider/tax receipt.
8. The standalone Operations Reports module detects the new `cash_shifts` source **only** when the tenant also subscribes to Mobile Money and the analyst is allowed that source. Reports-only tenants continue using workspace reporting without Mobile Money.

## Roles and scope

- Tenant Owner: any active branch; may operate a shift, but **not** approve their own opening or closing count; independently approve other operators and investigate variances.
- Mobile Money Operator: own assigned branch and own shifts; may record and submit but not self-approve or view another operator's cash drawer.
- Branch Manager: assigned branch only; can verify opening cash and review zero-variance close or dispute a mismatch; cannot approve a nonzero variance.
- Reconciliation Officer: assigned branch; can independently verify openings, approve closes (including documented variance), or dispute.
- Auditor: read-only physical cash shift evidence, branch-scoped by assignment.
- Reports Analyst: aggregates only through a separately licensed and authorized Reports + Mobile Money source; cannot view individual physical cash shifts or perform transactions.
- Viewer: cannot access physical cash counts.

Permissions are rechecked against the current session, current subscription, individual module assignment and server-derived branch for each request. CSRF validation and financial action throttling apply to writes.

## Implementation and migration

Run `npm ci`, `npm run check`, `npm test`, `npm run perf:assets`, and `npm audit --audit-level=moderate` with registry connectivity. For an isolated, local MongoDB replica set, run `npm run db:dev:up`, `npm run indexes`, `npm run cash:integration` and `npm run release:gate`.

`npm run cash:integration` uses random temporary tenant databases and refuses non-loopback MongoDB hosts or production mode. It covers two-person opening verification, uniqueness, record linkage/idempotency, internal review, void, cash submission, discrepancy, independent approval, reporting and cross-tenant denial.

**Migration:** This release adds `SecureCashSession` with a unique partial index on `activeKey` and the nullable `cashSessionId` field on `SecureMobileTransaction`. Old entries remain unassigned for historical viewing/reporting; do not manufacture cash movements by attaching them to new shifts. New recording requires a verified `open` shift. Ensure a supervisor is available before opening a shift. Take a database backup and verify the indexes before enabling the new requirement for active staff.

**Rollback caveat:** Reverting application code after creating new shifts cannot remove the new audit history. Preserve new collections and field values. No automatic destructive down migration is supplied. Rollback images should remain compatible with the extra fields while any shift is unresolved, and a formal migration plan is needed before enabling real money.

## Evidence / release gates

Source tests and the local public-page smoke test are not proof of production readiness. Required external evidence: a real replica-set transaction test, `npm audit`, concurrency/load and exception tests, backup restoration, staging deployment and rollback, browser-based accessibility/performance review, verified operational roles and MFA, and independent provider adapter and reconciliation tests once API credentials become available.

The original `public/css/dashboard.css` is unchanged. A separate small stylesheet is used only for printable acknowledgements. No production server or Git remote was changed by this release.
