# Classic FinHub — Mobile Money + Forex settlement design

Status: **design only; NOT implemented or production-enabled**. Prepare for the next accounting release after validating provider and regulatory permissions. The currently deployed same-currency MoMo flow remains unchanged.

## Decision

MoMo is the **electronic-money provider/channel**. Forex is the **cross-currency pricing and gain/loss component**. Treasury is the **one source of truth for native-currency cash, wallet and bank assets**. Never create a second "forex drawer" when the same SSP notes are held in a shared physical cash drawer. One customer operation has one immutable record and one linked atomic financial posting with two native-currency custody legs.

### Custody direction (agent's perspective)

| Agent operation | Uganda wallet (UGX) | Physical drawer (SSP) | FX dealing side for UGX |
|---|---|---|---|
| Customer withdraws UGX and accepts SSP | **Increases** by net UGX received | **Decreases** by SSP actually paid | Agent **buys UGX** (bid) |
| Customer deposits SSP to obtain UGX e-money | **Decreases** by UGX sent | **Increases** by SSP actually received | Agent **sells UGX** (ask) |

Differentiate provider gross principal, provider net float movement, provider fees, provider commission and independently collected business charges. Never conflate electronic and physical currencies. Confirm provider's exact credited/debited fields against statements before implementing any signed fee treatment.

**Illustrative only:** Withdraw UGX 100,000, customer receives SSP 90,000 (rate 0.9 SSP/UGX). Provider float **+100,000 UGX**, actual SSP drawer **-90,000 SSP**. This example is *not a market rate*. Neither UGX 100,000 nor the supposed difference is income.

## Compliance go/no-go

1. Determine whether the tenant's provider-agent contract permits the local country of operation and foreign-currency settlement; require written authorization where applicable. The public MTN Uganda agent terms describe the Uganda service territory and fee rules. A FinHub feature must never be treated as provider authorization.
2. Verify exchange-dealing licensing/regulations and reporting in the specific operating jurisdiction, including South Sudan and any Uganda cross-border implications. Require tenant-level attestations backed by appropriate documents and a recorded verification status.
3. No cross-currency posting without explicit feature entitlement/approval by the platform's compliance process. Tenant Owner may configure approved market rates but cannot unilaterally override provider/legal restrictions.
4. Enforce the above server-side for each tenant/branch/provider/account combination, never through hidden UI alone.

## Required models (all tenant-database scoped)

- **TreasuryAccount**: accountKind=wallet/cash/bank; network; native currency; physical owner/branch; opening; book balance; verified external/current observation. The same SSP drawer is reused for all compatible business modules.
- **RateBook**: canonical pair UGX/SSP, quote convention *SSP per one UGX*, bid (buy UGX) / ask (sell UGX), exact decimal, branch, effective dates, approvedBy, immutable version; reject ambiguous inverse quotes and stale/unsigned rates. The existing approved Forex Buy/Sell rate separation should be reused with a clear side-to-agent mapping.
- **MoMoCustomerOperation**: tenant, branch, operator, network+agent wallet ID, provider reference/confirmation, providerCurrency, principalMinor, cashCurrency, actualCashMinor, bid/ask, rateVersion, rateExact, roundingMinor, providerFeeMinor, providerCommissionEvidence, status, timestamp+IANA timezone, idempotencyKey, journalBatchId, FX settlement link. No inferred "foreign" physical cash drawer.
- **FxCostBasisLot**: foreign monetary units acquired, SSP carrying cost, cost remaining, acquisition source, authorized opening basis, immutable allocation history. Choose **weighted average** as initial product policy; implement with per-wallet/branch concurrency fences to prevent double allocation. If true functional currency is not SSP, determine it per tenant with accounting review.
- **FinancialJournal**: immutable balanced debits/credits **per currency** using explicit FX clearing accounts, plus functional-currency valuation entries. Never sum raw UGX with SSP; every journal must pass native-currency and base-currency integrity checks.
- **ProfitView**: actual recognized commission and charges, realized FX dealing result on disposed float/currency, FX monetary remeasurement difference, direct expenses, allocated shared expenses, and *unavailable cost basis* state when necessary. The cost of acquired float is an asset, not an expense.

## Transaction process

1. User chooses provider wallet; system resolves its fixed provider currency and assigned branch. Cash currency defaults to the actual branch drawer currency (SSP in this example). Operator cannot relabel an UGX wallet as SSP.
2. System displays provider amount, live **approved** bid/ask quote from rate book, the **actual SSP payable/receivable**, independent provider/customer charges, and expected wallet/drawer changes. No implicit rate or exchange from the central bank.
3. Verify network/provider result and reference, validate sufficient available wallet or cash (as appropriate), verify approved drawer opening and no hold, confirm actual amount handed over, and lock the approved rate and the timestamp.
4. **One database transaction:** fence branch/actor/permissions; idempotent unique provider ref and logical operation ref; lock wallet and cash, derive exact Decimal128 amounts, write the two custody legs and balanced FX clearing/functional-currency journals; allocate cost basis if disposing float; insert immutable operation evidence; update balances; queue nonblocking notification/outbox. Reject entire transaction if any leg fails.
5. Complete normal verified transaction immediately, **no extra managerial approval**. Only unsupported/unconfirmed provider events stay pending; high-risk entries alert the Tenant Owner without blocking valid work, unless a defined fraud/AML rule requires a hold.
6. Corrections/chargebacks are **new linked reversing journals** and adjustments with Tenant Owner/reconciliation authorization; never delete, edit, or backdate posted financial history. Concurrent retry uses the same idempotency result.

## End-of-day checks

- Separate actual vs expected **UGX float** from provider statement; compare SMS/API events for duplicates, missing credits and charges.
- Separate actual vs expected **SSP banknotes** by count for each physical cashier/shift; an SSP discrepancy cannot be "fixed" by changing an UGX rate.
- Posted FX deals reconcile provider principal, physical-cash leg, rate snapshot and cost-basis consumption. Distinguish pending provider verification, mismatch, reversals and verified postings.
- Report per tenant, region, branch, operator, module, network, wallet, physical drawer and currency. Retain UTC instants but calculate business dates using each verified IANA timezone.
- Owner dashboard shows: cash SSP, wallet UGX, other currency assets, deposited/injected owner capital (equity), capital employed/asset value, MoMo realized commission, collected approved charges, realized FX trading margin, exchange-rate remeasurement gain/loss, direct and shared expenses, net income. **No single capital total** until conversion is done using an explicitly dated valuation rate.
- An operation linked to MoMo and Forex counts **once** in all-module transaction volume; Forex-only analysis can include it as a separate category `momo_fx`, but never create a second sale or double-post wallet/cash principal.

## Accounting example (hypothetical, not market quote)

A previously purchased UGX 100,000 float lot has SSP 90,000 carrying cost. A subsequent customer **deposit** delivers UGX 100,000 from this wallet and brings in SSP 110,000. Provider commission, fees and tax are independently posted when confirmed.

The wallet loses UGX 100,000, the SSP drawer gains SSP 110,000, and the **illustrative gross dealing result** is SSP 20,000 before costs, provided the lot cost and execution are fully evidenced. If cost basis is missing, display **Unmeasured profit**, never SSP 110,000 income or SSP 20,000 as a guess. Under IAS 21, foreign-currency monetary assets are also translated under the applicable functional-currency and reporting-date rules; keep remeasurement separate from operational trading results.

## Release stages and non-negotiable tests

A. Confirm legal/provider configuration and reconcile existing opening balances with evidence. Existing legacy quote-only Forex rates remain unclassified; do not guess Buy/Sell rates or retroactively rewrite closed transactions.

B. Ship tested pair/side/rate preview + exact pricing with no ledger writes. Prevent stale rate, reversed side, unsupported pair, crossing bid/ask and negative payout.

C. Add transactional two-currency journal posting and cost basis: test deposit, withdrawal, insufficient cash/float, concurrent duplicate provider events, repeat HTTP requests, failed audit/FX leg, cross-branch access, pending provider evidence, rounding, balance reconciliation, reversal and multi-tenancy.

D. Add read-only P&L reports and double-counting prevention. Validate day-close against **real independently counted cash** and **provider wallet statements**. Keep feature disabled until operational/legal acceptance.

E. Roll out per approved tenant/branch/provider with kill switch and monitored canary; permit rollback only after planning for DB-schema/journal compatibility. Backup and restore rehearsal required.
