# Classic FinHub — Mobile Money Tenant Onboarding & Operations Manual

**Audience:** Tenant Owner, Mobile Money Operator, Reconciliation Officer and Branch Manager.
**Applies to:** Cash-In/Cash-Out agent recordkeeping, physical cash, provider electronic float, fees, commission payout evidence, cash shifts, SMS-assisted capture and reporting.
**Status:** User operating manual for the controlled software workflow. It does **not** represent direct authorization to execute transactions on MTN/Airtel, real-time provider balance access, or proof of provider settlement.

## 0. Understand the accounting boundary

- **Cash-In:** customer hands physical cash to the agent; the licensed provider sends electronic value from the authorized agent float to the customer. Agent cash **increases**, agent float **decreases**.
- **Cash-Out:** the provider transfers electronic value from the customer to the agent; the agent hands the customer physical cash. Agent cash **decreases**, agent float **increases**.
- Principal movements are exchanges between business assets, **not sales revenue**. Cash + electronic float is not profit.
- A **network customer charge** generally belongs to the provider. It is not automatically an agent fee or commission.
- **Agent commission estimate** is a contract/rate-sheet quote, not money received. Book income only under a verified settlement/accrual policy.
- **Cash shift** is operator accountability. **Treasury account** is an independently verified asset balance. Both are required for cash operations.
- Internal review means supporting evidence was inspected. It **does not** make a pending provider operation settled.
- **Manual** and **approved SMS-assisted capture** are the two software entry channels. The software does not originate provider payments.

## 1. First-time Tenant Owner checklist

1. Sign in to your tenant workspace and confirm the tenant identity. For a production finance tenant, verify actual business name, legal jurisdiction and correct billing/operating branch.
2. Ensure Mobile Money is enabled in the tenant plan and assigned to staff. Assign Expenses and Operations Reports if you need these cross-module summaries. SMS capture requires its own entitlement and configured quota.
3. Create an active branch in **Branches**. Set real operating currencies. Staff operate in their assigned branch; transaction forms must not accept an arbitrary user-entered branch.
4. Invite users with separate credentials: at minimum a Tenant Owner, Mobile Money Operator and an independent Reconciliation Officer. The reviewer cannot approve an observation, shift or transaction they originated.
5. Open **Treasury** at `/tenant/treasury`. Create one actual cash drawer **assigned to its physical custodian/operator** and an actual provider float wallet with the correct provider market and currency.
6. Account codes are generated automatically from account type, provider/currency and a unique ID. Do not duplicate or hand-edit bookkeeping IDs.
7. Currency follows the provider: **MTN MoMo Uganda → UGX**, **Airtel Uganda → UGX**, **MTN MoMo South Sudan → SSP**. A provider whose market is unresolved needs an approved market-specific wallet, not an arbitrary guessed currency.
8. Only create one default wallet per network, currency and operator/shared scope. Add other wallets only when they correspond to **real distinct provider accounts**. Never create duplicate live wallets to fix a typo. In the wallet's **Account settings**, link it to the correct independently approved physical drawer when the operator has more than one matching cash drawer. If exactly one approved drawer exists, the system resolves it automatically. The operator never chooses a drawer on the transaction form.
9. Submit the real opening physical count for cash and the real provider screen/statement balance for float. Use accurate observation dates, source references and evidence notes.
10. Have a different Reconciliation Officer approve both openings. Confirm that Treasury displays **active · matched**, a known opening, and zero reviewed variance.
11. Do not attempt to operate when the account is held, mismatched, missing opening approval or the provider float is insufficient.

## 2. Shift opening: operator and reviewer

1. The correct assigned operator signs in to `/tenant/cash/shifts`; **never have the Tenant Owner open a shift for an employee's assigned cash drawer**.
2. Count physical cash. Choose the operating currency (normally derived from the branch) and enter the exact amount. It must agree with the assigned Treasury cash book at shift opening.
3. Click **Open day with these balances**. State becomes `pending_open`.
4. An independent supervisor or Reconciliation Officer inspects the physical count and opening evidence; approve or reject with explanation.
5. Confirm shift state `open` and that it is bound to the same operator, branch, currency and Treasury cash account. A different user's open shift is not usable by this operator.
6. Keep the open shift until all genuine transactions and related review/reconciliation work are complete.

## 3. Manual MTN/Airtel Cash-In or Cash-Out

1. Use the provider's **authorized agent service** to complete the genuine customer transaction before entering it as completed.
2. Receive or disburse the actual physical cash as the provider instructions require. Do not exchange cash on an unverified/pending network instruction.
3. Sign in as the assigned operator, then open `/tenant/mobile-money/cash-in` (deposit) or `/tenant/mobile-money/cash-out` (withdrawal).
4. Select the provider if more than one approved market wallet is available. Network currency is derived automatically; for MTN Uganda it is UGX. Payment method is automatically **Cash**.
5. The platform chooses the **provider float wallet** and the operator-owned physical drawer linked to that wallet. The only configured provider is selected automatically; with several, **MTN Uganda (UGX)** is the initial default when available. Currency follows the chosen provider. If multiple drawers qualify, the transaction is blocked until the Tenant Owner configures the matching real drawer in Treasury; the teller cannot choose one.
6. Enter the real customer phone/name as required, actual principal amount, and the unique provider transaction reference from an authentic provider confirmation.
7. Review configured transaction-fee preview and any reference-only provider charges/commission estimate. Confirm the real provider amount and collected cash; estimated commission is **not** part of today's principal.
8. Click **Record deposit** or **Record withdrawal** **once**. The backend commits one atomic internal posting with a unique idempotency key and journals. It does **not** call MTN/Airtel to execute a transfer.
9. The record starts at `pending_verification` and `awaiting_review`. Obtain independent review after external evidence is checked. An internally accepted record may still have provider status pending; do not call that settled.
10. Check transaction details: cash delta, float delta, funding journal IDs, real provider reference, operator and linked cash shift. No transactions with made-up references should be left in financial books.

### Physical-cash principal example (not a transaction to enter)

- UGX 250,000 Cash-In with no separately collected fee: Cash +250,000; MTN float −250,000.
- UGX 250,000 Cash-Out with no separately collected fee: Cash −250,000; MTN float +250,000.
- The provider's customer network charge and the provider's agent commission are separate from these principal amounts.

## 4. Fee and commission configuration (Tenant Owner)

There are **three economic events** that must not be conflated:

1. **Agent-collected fee:** An additional amount the agent is legally/contractually entitled to collect and really receives from the customer. Tenant Owner configures pricing under `/tenant/workspace/pricing` and the wallet fee policy under its Treasury settings. Only choose **Verified fee collected from customer** when authorized; it changes the actual cash received/paid. Pricing is snapshotted per transaction and can be recalculated when configuration changes; the server validates the policy again.
2. **Provider customer charge:** A fee charged by MTN/Airtel directly to the customer's wallet under provider tariff. It is displayed as provider reference/estimate, **never** as the agent's revenue unless documented otherwise.
3. **Agent commission:** Provider remuneration for qualifying deposits/withdrawals. Tenant Owner/operator creates *agent commission* tariff bands under `/tenant/mobile-money/tariffs` from a dated, genuine contract/provider rate sheet. A different authorized reviewer approves the schedule. Quotes are automatically calculated and snapshotted for transactions within approved effective bands. **Operators never manually enter agent commission.** If no approved rate applies, the form and reports show **Not configured / unknown**, not a fabricated zero. Quotes remain unreceived estimates, not posted spendable float.

### Where should an actual provider commission credit go?

When the provider really credits a payout, choose the **receiving account shown on the provider statement** in **Mobile Money → Agent rate sheets → Received provider commissions**:

- If the provider credited your existing float wallet, select that real float wallet.
- If the provider maintains a separate commission wallet/line, create a distinct real commission wallet in Treasury, independently approve its opening balance, then select that account on the payout.
- A bookkeeping preference must never redirect money to a wallet where the provider did not credit it. A separate reporting label is **not** evidence of separate electronic funds.
- Enter exact provider payout reference, gross, net, withheld taxes, provider deductions, credited date and statement evidence.
- The independent Reconciliation Officer reviews. An actual income/float posting is available only when the **commission posting release gate** is explicitly enabled after accounting migration and provider verification. Do **not** force this setting on to make test revenue appear.
- Historical `wallet_commission` entries must be audited for possible double counting. New operator transactions cannot use that speculative legacy policy. `record_only` is the safe starting policy.

### Fees/commissions summary

| Quantity | Account treatment | Reporting label |
| --- | --- | --- |
| Principal Cash-In/Cash-Out | Cash and provider float movements | Transaction volume / cash impact |
| Configured agent-collected fee | Only when truly collected | Collected fee income |
| Provider customer network fee | Usually provider's charge | Provider charge estimate |
| Provider agent commission estimate | No funds movement | Expected commission, not received |
| Provider commission payout received | Posted only against authenticated evidence and appropriate gate | Commission actually received |
| Withheld tax and provider deductions | Separate ledger treatment under approved policy | Tax / network costs; not hidden in profit |

## 5. SMS-assisted capture: second and only automatic entry mode

1. Confirm that a separately entitled **SMS Capture** module is active, a dedicated agent Android device is available and the owner's operating provider sends supported confirmation messages.
2. Owner enrolls the exact device, trusted sender IDs, operator, provider and branch in **SMS Capture**. Configure the dedicated Android phone with the repository's `tools/android-sms-relay/README.md`, Termux and Termux:API.
3. The relay uses a unique device secret, signed HTTPS requests, sender allowlists, encrypted tenant inbox and durable local retry/duplicate suppression.
4. Unrecognized, changed, incomplete, reversed, failed, forwarded or suspicious messages remain for manual review; they are **not** silently converted to successful payments.
5. Automatic recording, if entitled and enabled, posts supported confirmations as **pending verification** with the same branch, operator, active cash shift, funds-book and independent-review controls. An SMS signature authenticates the enrolled device transport, **not the provider's original sender**.
6. Verify actual provider SMS wording on a real dedicated agent SIM before activating automation. The bundled strict example parser is not guaranteed to match native MTN/Airtel SMS formats. No OTP, PIN or full personal inbox should enter ordinary logs.
7. If the device loses power/network, recover queued messages safely. SMS older than the approved shift or outside retention boundaries requires investigation, not automatic backdating.

## 6. Shift closing and reconciliations

1. Review every pending transaction, variance and authorized correction before attempting closure.
2. Count the actual physical cash in the assigned drawer. Confirm against Treasury cash and the shift's provisional expected value.
3. Operator submits the shift close from `/tenant/cash/shifts/:id`, with explanation if there is a surplus/shortage.
4. A different authorized reviewer approves/disputes closing count. Do not reopen approved shifts or delete their history. A closing count may create an independent Treasury checkpoint.
5. Independently check the electronic float from the provider app/statement. Submit a dated Treasury wallet checkpoint and obtain review. A pending or mismatched checkpoint can hold future spending.
6. Investigate differences; correct underlying missing records or approved adjustments with audit evidence. Do **not** reset balances to make them match.

## 7. Business report: daily to annual

Open `/tenant/mobile-money/report`. Choose **Today**, **This week (Mon–Sun UTC)**, **This month**, **This quarter**, **This year**, or **Custom dates** (up to a calendar year). You can also filter by provider and currency. Export **consolidated CSV** if authorized.

Each currency section shows:
- Deposit/withdrawal counts and principal transaction volume.
- Net physical cash movement.
- Explicitly collected agent fees (**only** that fee treatment).
- Provider commission estimates (**not** actual income).
- Independently reviewed and posted real commission payouts (net and gross).
- Withheld tax and provider deductions where supported by payout evidence.
- Historical `wallet_commission` amounts flagged separately for double-counting review.
- Pending internal reviews, provider-unverified records, voided originals, and manual/SMS source counts.

Provider/currency rows stay separate; **UGX, SSP, USD and KES must never be added directly together**. A posted provider commission may be included by the date of provider credit; approved branch expenses use their review dates. Expenses are reported separately by currency because they can serve multiple networks/modules and cannot be assigned to MTN or Airtel without explicit allocation evidence.

**No true net-profit number is claimed** until received/earned commission, lawful customer fees, supplier/provider costs, payroll, expenses, tax and allocations can be reconciled with complete supporting evidence.

## 8. Operating exceptions

| Problem | Required response |
| --- | --- |
| Transaction entered with fabricated reference | Origination operator requests audited internal void; independent reviewer approves reversing journals. No manual DB edit. |
| Real transfer but wrong provider reference | Investigate, void/re-record with independent evidence and no duplicate provider transfer. |
| Cash drawer belongs to another operator | Do not force association. Close incorrect unused shift through normal review, then open a shift as assigned custodian. |
| No matching wallet/currency | Owner creates a genuine network-specific account; opening balance independently verified. |
| Cash/float mismatch | Submit fresh actual observation and investigate before continuing. |
| Commission shown as estimated but no payout | Leave it unreceived and do not increase float or profit. |
| Commission payout has tax/deductions | Preserve evidence; posting is blocked until verified tax accounting is implemented. |
| SMS format unknown | Store as needs review; do not guess customer, amount, fee or transaction success. |
| Network transfer timeout | Confirm provider state before any retry; keep unknown state and avoid duplicate financial moves. |

## 9. Before turning on for all employees

- Complete the existing fabricated `ref123456` transaction correction, if still pending, and verify cash/float restoration.
- Verify two-person reviewer permissions, tenant-specific plans, branch assignment and the real operator drawer.
- Obtain signed rate sheets, real provider statements, signed commission examples and actual native SMS formats.
- Test Cash-In, Cash-Out, shortages, double submission, concurrency, SMS duplicates and out-of-order messages, provider reversal, void, payout, shift close and restore-from-backup in staging.
- Do not enable `ENABLE_MOMO_COMMISSION_POSTING` without passing the documented historical migration and end-to-end financial release gates.
- Release only after CI, database index checks, smoke tests, monitored canary and rollback preparation. Preserve every verified historical entry and approved UI treatment.

## 10. What is explicitly not included in this completed workflow

- Direct MTN/Airtel agent transactions using provider APIs.
- Guaranteed native provider SMS parser compatibility or sender authenticity.
- Automated provider settlement state and bank/provider statement matching.
- Automatic booking of provider commission with withholding tax or deductions.
- Financially audited network-specific net profit where expenses are shared.
- Airtime sale, bill payment, merchant checkout, wallet-to-wallet customer account transfer or money transfer/forex under the Cash-In/Cash-Out forms.

Those operations need separate provider authority and economic posting rules. Keep the Mobile Money operational scope honest: **manual and validated SMS-assisted entry, real cash/float books, independent review, and transparent evidence-based reporting**.
