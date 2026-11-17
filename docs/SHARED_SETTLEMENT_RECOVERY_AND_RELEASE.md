# Shared Mobile Money – Forex – Money Transfer: recovery and release contract

> **Status (2026-11-17):** Development branch only; new cross-currency posting is **not enabled on production**. The code has isolated replica-set testing but no proof of real external provider settlement. Do not change `CLASSICFIN_LINKED_CURRENCY_POSTING` to `enabled` as a substitute for operational acceptance.

## Money and ownership invariants

- The provider wallet holds network-native float in its own currency (KES, UGX, etc.). The cashier's physical drawer holds *real banknotes* in its actual currency (often SSP in South Sudan). One existing Treasury cash account is reused across entitled modules, never copied per transaction.
- Every physical cash movement belongs to the actual branch, cashier, shift, and currency. The money-transfer receiver can use a different physical drawer/currency at a different branch.
- Money-transfer collection is **not payout**. Collection creates custody and an outstanding obligation; an authenticated receiver PIN and a different authorized reviewer are needed before recipient cash is booked as paid.
- A balanced internal journal is **not external network settlement**, bank transfer, physical cash counting, interbranch liquidity payment, realized FX profit, or evidence that a customer actually received external funds.
- All totals and CSVs keep native minor units and explicitly display currency. Never add SSP to KES or USD; never guess conversion, rate, provider charge, received commission or weighted cost basis.

## Supervisor recovery queue (read-only)

Location: **Money Transfer → Branch transfer balances → Unpaid transfers needing follow-up**. It shows a bounded, role- and branch-scoped view of transfers where sender cash is recorded but recipient payout remains incomplete.

| Observed state | What is true | Safe next action |
| --- | --- | --- |
| `awaiting_recipient` | Collection posted; no payout currently awaiting approval | Verify sender reference and beneficiary identity. Use the existing **Payout by PIN** flow when eligible. Never create a duplicate order |
| `awaiting_payout_review` | Recipient payout has **not** been posted | Independent reviewer examines the exact destination drawer, branch, PIN verification, and evidence. Payout is **not** yet complete |
| `payout_rejected` | Prior attempt rejected; the sender collection remains booked | Investigate reason, correct source data only through legitimate separate procedures, and if eligible request a *new payout attempt* after a fresh verification of the **original** PIN. Never treat rejection as refund |
| `inconsistent_paid_status` | A payout execution says posted, but original order still says collected | **STOP payout and refund.** Independently investigate original journal batch, payout batch, source state and tenant audit before making any movement |
| Collection is older than 24 hours | Follow-up reminder, **not expiry** | Owner/branch supervisor checks the beneficiary and actual liabilities. No automated cancellation or release of collected cash |

Only the newest 50 outstanding records per authorized scope are displayed. This is **not** an exhaustive regulatory report; the separate audit and operational history remain authoritative.

## Before any collected transfer refund or reversal can ship

A **real in-app cash refund workflow is still pending**, and it must be **separate** from undoing the original internal posting:

1. Lock original source, collection execution, any active PIN verification, linked settlement and payout attempt in one serializable or conflict-safe database transaction.
2. Prove that no recipient cash was paid and no external provider payment remains uncertain. Missing evidence, offline payout terminals and delayed callbacks mean **hold for investigation**, not refund.
3. Identify the sender and return **the actual refundable amount and currency** from a real authorized physical drawer; independently review amount, original fee treatment and customer receipt. A branch cannot refund from an unrelated operator's drawer.
4. Book explicit, balanced **compensating journal entries** with new references and append-only evidence. Do **not** delete original history or automatically reverse a settled external payment.
5. Reconcile cash counts, outstanding transfer liability, original and compensating journals, customer notices and owner alerts. Safe retries must be idempotent across every branch.
6. Verify rejection, crash-after-commit, duplicate submission, concurrency, revoked operator, insufficient funds, held drawer, missing proof, foreign currency mismatch and provider timeout with real replica-set tests.
7. Only then expose a permission-checked refund request/independent review interface. A cosmetic Refund button or automatic "reversal" would be dangerous.

## Daily financial reconciliation

For each branch, cashier, provider and currency separately:

- Match the actual physical drawer count to Treasury posted movements and the last independently reviewed observation.
- Match the wallet float posting to provider-controlled evidence. Pending or manual evidence is not external verification.
- Match transfer collection (origin drawer and liability) to verified recipient payout (destination drawer) and independently settled interbranch dues. An SSP payable and USD receivable cannot be netted by simple arithmetic.
- Recognize fees only on authorized rules with supporting cash/payment evidence; recognize commission only on independent provider proof.
- Do not recognize FX profit until approved rate, actual liquidity flow, per-currency cost basis and settlement expenses are substantiated.
- Flag missing collection or payout evidence, duplicated provider references, source/execution disagreement, aged unmatched branch dues and transfer attempts requiring review.

## Production acceptance gate

- Full CI **and** scratch replica-set gate at the exact release commit.
- Protected staging tenant with real role and branch matrix including South Sudan SSP, Uganda UGX, Kenyan KES and USD.
- Browser checks on the **approved original dashboard and existing forms**; correct local business timezone display, PDFs/receipts, offline behavior and no misleading loading or success states.
- Backup plus tested restore and rollback of image, exact source SHA and MongoDB data, index inventory and redacted secrets handling.
- Verified provider statement/API or independently validated SMS ingestion, duplicate and out-of-order evidence handling, unknown/failed callback investigation and owner alert delivery.
- Written refund/compensation controls and operational training before real funds processing.
- No real customer transactions during acceptance tests. Keep the release flag off until the production readiness gate is approved.
