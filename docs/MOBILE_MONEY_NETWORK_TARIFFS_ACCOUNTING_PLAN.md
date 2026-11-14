# Mobile Money agent operations — financial correctness contract

Status: DESIGN + isolated non-posting tariff engine. **Not enabled in live transaction posting.**
Checked: 2026-11-14. Review required before activation.

## Existing capabilities to preserve

- Tenant database isolation, branch- and operator-scoped treasury wallets and cash drawers.
- Existing atomic `treasury.applyMovements`, idempotency/reference uniqueness, correction/void workflow, manual wallet observations and independently reviewed reconciliation.
- Existing Mobile Money operations `cash_in` and `cash_out`; existing fee policy `record_only | payment_collected | wallet_commission` needs migration before new agent commission accounting can be enabled.
- Multi-currency amounts stored in exact minor units; no cross-currency netting without an explicit FX transaction.

## Provider source status

| Network | Market | Currency | Customer tariff | Agent commission | Live automatic posting |
| --- | --- | --- | --- | --- | --- |
| MTN MoMo Uganda (`MTN`) | Uganda | UGX | Published on https://www.mtn.co.ug/tariffs/mobile-money-tariffs/ | Published on https://www.mtn.co.ug/momo/agent/ ; reference-only schedule encoded in `networkTariffs.js` | OFF |
| Airtel Money Uganda (`Airtel`) | Uganda | UGX | Published on https://www.airtelmoney.ug/transaction_fees | Current signed agent commission sheet not verified | OFF |
| MTN MoMo South Sudan (`MTN SSD`) | South Sudan | SSP | Official service confirmed https://www.mtn.com.ss/momo-ss/ ; complete live tariff not verified | Not verified | OFF |
| Africell | Market must be identified | — | Not verified | Not verified | OFF |
| M-Pesa | Market must be identified | — | Not verified | Not verified | OFF |

MTN Uganda's public agent table and older PDF differ in some deposit/withdraw commission bands. This is why a reference source is not a live-approved effective tariff. A signed agent-specific commission agreement or provider statement is authoritative for this agent, subject to verification.

## Exact terminology

- **Cash deposit / Cash-in**: customer gives *physical cash* to the agent; agent transfers *own electronic float* to the customer.
- **Cash withdrawal / Cash-out**: customer transfers electronic value into the agent wallet; agent pays *physical cash* to the customer.
- **Float**: provider electronic value in the agent account; asset separate from cash drawer.
- **Customer network fee**: provider's published charge to the customer; **not** the agent's commission. Do not book as the agent's income unless independently collected on the agent's own account under a lawful contract.
- **Agent commission estimate**: expected remuneration from provider schedule, never a balance.
- **Accrued commission receivable**: amount legally earned under configured settlement contract and evidence, may be recognized only by an approved accounting policy.
- **Commission received**: provider statement credit or independently verified commission-line posting; do not duplicate an already-accrued receivable.
- **Tax withheld, tax payable and network operating cost**: distinct from both cash/float principal and gross commission.

## Balanced principal movement — agent is the reporting entity

Customer cash-in 100,000 UGX:
- Debit cash-in-hand asset +100,000.
- Credit MTN float asset -100,000.
- No revenue recognized from exchanging principal.

Customer cash-out 50,000 UGX:
- Debit MTN float asset +50,000.
- Credit cash-in-hand asset -50,000.
- No revenue recognized from exchanging principal.

`feeTreatment=wallet_commission` should **not** be used for a merely *estimated* commission: the provider may credit commission separately once a day, and increasing float during the principal transaction would invent funds and later double-count the credit. Maintain its existing behavior for historical records until a versioned conversion and settlement test are approved.

Commission paid to wallet (without prior accrual):
- Debit provider commission wallet asset +1,000.
- Credit earned commission revenue +1,000.
- Use a unique provider settlement ID + bank/agent statement evidence; never reuse customer transaction's idempotency key.
- If the commission was already accrued, debit wallet and credit receivable rather than credit revenue again.
- Record withholding tax and other deductions separately if evidence supports them.

Customer pays a **provider withdrawal charge**: do **not** add that charge to the agent's cash or income. Customer charges, provider duties, taxes and agent contract commission are different cash flows.

## Minimum posting invariants

1. Every movement balances by currency, tenant and branch, in one database transaction. Failed posting must leave neither the operation nor journal partially committed.
2. Exactly one physical cash drawer and correct provider float wallet per operation; no network aliasing (`MTN` and `MTN SSD` separate). An operator cannot use another operator's assigned cash account.
3. Reject insufficient cash/float, inactive wallet, unapproved opening balance, stale authorization, missing branch currency, unknown network and wrong fee basis.
4. Provider transaction ID is unique by network + agent wallet identity + transaction namespace. An idempotent retry returns the same posted result only for identical inputs.
5. Provider-confirmed transaction evidence must be distinguished from a manually entered transaction and from an internal review. Never label an internal acceptance as provider settlement.
6. No posting of tariff quotes; actual commission settlement needs statement/SMS evidence, approved matching and unique `providerSettlementRef` per operator/network/currency/period.
7. Tariff changes are append-only revisions with `effectiveFrom`, source URL/document reference, reviewer and two-person approval. Existing transactions retain their historical tariff snapshot.
8. Treasury balances are derived from immutable ledger movements, not recalculated from tariff sheets or exported transaction totals.
9. Daily cash count and provider float statement independently reconcile against books, with recorded variance, reviewer, timestamps and corrective journal when approved. No silent balance reset.
10. Reports separate *transaction volume*, *net cash movement*, *float movement*, *gross commission quoted*, *accrued commission*, *received commission*, *tax*, *cost*, *realized profit*, *unsettled receivables*, and *unreconciled balances*.

## Agent editor and activation plan

1. Tenant Owner or permitted Pricing Manager uploads provider tariff sheet, chooses provider, branch, currency, operation, effective date and source; operator may propose but cannot self-approve financial terms.
2. Validate contiguous/non-overlapping bands, scale, rate precision, limits, rounding, version and source status. Handle tier gaps as **no quote**, never substitute a zero-commission figure.
3. Second authorized person reviews and activates. Simultaneous changes fail with optimistic revision check.
4. Quote is displayed separately from customer charges; no automatic income posting at transaction entry. The network payout frequency and method govern receivable and settlement recognition.
5. Integrate with existing `mobileMoneyFunds.service` only after legacy `feeTreatment` migration, statement ingestion, correction handling, internal/real cash reconciliation and ledger invariants have integration tests.
6. Customer transfer, airtime, bills, merchant payments, reversals, loans, cross-network operations and cash/float replenishment each need distinct economic posting rules. Do not merely reuse cash-in/out.
7. Provider tariffs may change without notice; do not silently overwrite a tenant's approved contract schedule or backdate postings.

## Completion criteria before declaring production-ready

- Provider-specific fee & agent-commission sheets verified; missing rates visibly unknown.
- Role-restricted tariff management, maker-checker approval, audit, source records and rollback.
- Quoting, fee/cost/commission separately persisted with immutable effective policy reference.
- End-to-end real transaction → balanced journal → SMS/statement evidence → reconciliation → profit & cash/float reports; duplicate, partial, out-of-order and reversal scenarios tested.
- Existing historical transactions and treasury balances unchanged until reconciled migration.
- Zero critical discrepancies, smoke tests and rollback exercise on staging before production rollout.

**No existing deployed production accounting route calls `networkTariffs.js` yet.** Its public MTN Uganda rate table is safe as reference only, and cannot create money.
