# Loan Management — next-module architecture (not released)

Status: **Planned / not enabled**. This is a product design specification, not a working module.
The public site may describe it as *Coming soon* but must never show active pricing, a working loan application button, a tenant permission, subscription entitlement, or an available financial integration until end-to-end tests pass.

## Functional vertical slice

- **Tenant ownership and branch scope:** Owner configures products and policy; assigned managers create/review loans only within permitted branches. Database checks must enforce tenant, branch, module entitlement, and persisted roles at every write.
- **Borrowers:** Reuse existing customer directory and identifiers. No duplicate loan-specific customer identities. Borrower consent and documents, if required for a specific workflow or jurisdiction, are managed with strict access/retention.
- **Products:** Currency, interest basis, principal limits, installment rules, fees, grace, penalty, frequency, and rounding are immutable/versioned once referenced by an approved loan.
- **Lifecycle:** Draft application → submit → documented approval/rejection → disbursement → servicing → paid/closed, or an audited exception. Policy decides which approvals require a different actor; do not add arbitrary approval roles for routine work.
- **Repayments:** Deterministic schedule snapshots, exact principal/interest/fee allocation, partial/early/late repayments, idempotent receipt references, immutable journal batches, and per-currency balances.
- **Funding:** Loan disbursement debits only a real authorized source account; corresponding loan receivable records are balanced. Repayment credits the actual receipt account. Cash, bank and wallets remain distinct. Do not invent funds or sum unlike currencies.
- **Corrections:** Never physically delete an issued, disbursed or repaid loan. Use approved reversal/replacement journals, audit actor, reason, reference and timestamps; enforce outstanding balance and original transaction links.
- **Operations:** Due-date reminders and delinquency processing via durable queued jobs, safe retries, deduplication, time zone per branch, and delivery status. External payments are NOT verified merely because a callback or SMS arrived.
- **Reporting:** Per-branch/currency portfolio, outstanding principal, accrued vs collected interest, arrears aging, due today, collected cash, fund account matching, write-offs, recovery, and audit exports.
- **Recovery:** Backup/restore rehearsals, migration compatibility, reconciliation diagnostics, tenant-wide rollback safety; monitoring and alerts for ledger mismatches, failed jobs and unusual changes.

## Release criteria

1. Published schema and service contracts with permission matrix and idempotency keys.
2. CRUD for drafts/products, borrower assignments, approval, disbursement, servicing and closure.
3. Backend-fenced branch and tenant isolation; concurrency controls for disbursement and repayments.
4. Atomic balanced journal across source/receivable/collection accounts, in native currency.
5. Explicit handling of insufficient funds, duplicate callbacks, disputed payments and reversals.
6. Tests for every operation from UI through API and database, plus integration and production smoke verification.
7. Only after the above: enable module registry, pricing/subscription selection, navigation, and public claims of availability.

**Existing Mobile Money cash-first cross-currency flows and their FX postings are not to be changed by this module.**
