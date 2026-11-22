# Loan Management, Airtime & centered transaction feedback — release notes

## Deployment status
This PR is a **draft development release**. Neither module is automatically activated for an existing tenant, and this document is not evidence of a live production deployment. Keep the mandatory full encrypted MongoDB backup and isolated restore verification gate intact. Do not generate missing financial collections merely to make the backup gate pass.

## Centered transaction feedback
Shared dashboard session success/information flashes render as small, soft centered notifications with a dismiss action and short success timeout. Financial error flashes are persistent until dismissed; form validation messages retain their inline context. Existing branding, logout confirmation and reduced-motion preference are preserved.

## Loan Management
- Route: `/tenant/loans`; independent tenant entitlement `loans`.
- Roles: Tenant Owner and Branch Manager configure fixed flat-interest products and independently review applications; Banking Operator can originate applications and record actual repayments. The owner can create loans and record repayments within their permission set. Reviewers cannot independently approve their own applications.
- Register borrowers directly into the tenant's existing CustomerDirectoryV1 collection from Loan Management. A separate Customers subscription is **not required**.
- Product terms: one native currency, amount range, 0–10,000 basis points fixed flat interest, term of 1–730 days. This is a single-maturity/bullet-loan workflow; an amortizing installment schedule is **not** implemented.
- Applications reserve usage quota; submissions do not move funds. Approved disbursements must name an already opened, matched actual bank/cash/wallet account; a single MongoDB transaction debits it and creates the loan receivable posting.
- Only externally confirmed borrower repayments should be recorded. They credit a real account, reduce contractual interest then principal, and recognize only actually collected interest in income.
- A separate authorized reviewer can reverse the **latest uncorrected** loan repayment on verified refund evidence; it restores loan balances and posts the exact inverted Treasury journal while preserving original immutable evidence. Bulk modification, deleting loan history, automatic bank payouts and automatic collections are not implemented.

## Airtime
- Route: `/tenant/airtime`; independent entitlement `airtime`.
- Owner/Branch Manager configure manual products and purchase cost-basis stock against an actual funds source. A Mobile Money Operator can record operator-confirmed delivery and payment into an actual cash/bank/wallet account.
- Each sale consumes the saved acquisition cost, credits received proceeds, and books only realized gross profit. Values remain in the native currency; no invented customer fees or extra commissions.
- Stock is tracked **at acquisition cost, not retail face value or telecom provider balance**.
- Airtime is delivered externally by the operator. There is **no integrated provider API, automatic top-up, provider balance lookup or independent delivery callback**. Never show a manually entered transaction as a provider-confirmed API success.
- Owner/Branch Manager/Reconciliation Officer may record independent refunds **only after actual provider/supplier reversal and return of funds**, and only in reverse stock-event order. Treasury reversal, cost stock and audit evidence are atomic.
- Performance and CSV reports include corrections on their actual refund dates, so net gross profit is not overstated.

## Activation, pricing and permissions
- These modules are **not** added to existing published plan versions or current Enterprise plans.
- The platform administrator must explicitly grant module entitlement, set user/branch/record limits and enter an agreed USD monthly price (including zero only when deliberately approved). The platform does not collect the module price automatically. Tenant self-service requests cannot silently create $0 quotations.
- Staff assignments, branch scope, subscription changes, active-tenant state, MFA when enabled and server-side financial permissions are checked again inside Mongo transactions.
- Do not bypass module grant checks, backend authorization, idempotency or the backup restore gate to make a screen visible.

## Reporting and verification
- Both modules feed the tenant's existing Operations Reports source registry and authorized daily, transaction and dedicated reports; reports aggregate all matching financial records in native currencies rather than the latest 200 list items.
- Only collected loan interest and net realized airtime gross profit count as income. Disbursed principal and repayment of principal are **not** profits.
- `node scripts/retail-finance-integration.js` uses **only a disposable local unauthenticated loopback Mongo replica-set database**. It validates user entitlements, standalone borrower creation, duplicate requests, approval/disbursement, partial and full repayment, actual Treasury balances, inventory, refund reversals, loan restoration and zero net income after refund.
- `npm run release:gate` includes that check, along with the established full security and integration suite. Re-run on each release SHA.
- Verify real HTTPS pages, platform/tenant permissions, 4-up desktop/2-up mobile cards, responsive controls, local business dates, audit history and actual report exports before enabling tenant grants.

## Production rollback and data recovery
The application code can be rolled back to a pinned image if required. **Never drop newly written Loan/Airtime financial records or tenant databases during rollback.** Preserve immutable journals and audits, and reconcile any account state affected by partially completed external manual payments. A code rollback is not the same as reversing a business transaction. Production release must be preceded by passing backup/restore and tenant inventory integrity checks.
