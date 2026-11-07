# ClassicFin Hub operations manual

This manual follows the implemented platform from first installation and tenant onboarding to daily transactions, independent review, reconciliation, reporting and service recovery. It is for platform administrators, tenant owners, branch managers, tellers, reviewers and support operators.

Use the [production launch runbook](LAUNCH_RUNBOOK.md) for deployment, private environment configuration, database indexes, backup commands, release activation and rollback. Use [launch status](LAUNCH_STATUS.md) to distinguish checks already performed in the repository from acceptance checks still required on the real production host. Run those host checks before accepting live business activity.

## Contents

1. [Operating rules and responsibilities](#1-operating-rules-and-responsibilities)
2. [Platform installation and administrator access](#2-platform-installation-and-administrator-access)
3. [Products, plans and subscription pricing](#3-products-plans-and-subscription-pricing)
4. [Create and activate the first tenant](#4-create-and-activate-the-first-tenant)
5. [Tenant profile, branches and staff](#5-tenant-profile-branches-and-staff)
6. [Set up real wallets, cash, bank funds and stock](#6-set-up-real-wallets-cash-bank-funds-and-stock)
7. [Open the operating day](#7-open-the-operating-day)
8. [Mobile Money: manual entry and Android SMS](#8-mobile-money-manual-entry-and-android-sms)
9. [Customers, accounts and Banking](#9-customers-accounts-and-banking)
10. [Forex rates, quotations and manual exchange](#10-forex-rates-quotations-and-manual-exchange)
11. [Money Transfer: sender entry through final payout](#11-money-transfer-sender-entry-through-final-payout)
12. [Expenses, corrections and voids](#12-expenses-corrections-and-voids)
13. [Approvals and notifications](#13-approvals-and-notifications)
14. [Reporting and owner oversight](#14-reporting-and-owner-oversight)
15. [Close the day and resolve differences](#15-close-the-day-and-resolve-differences)
16. [Tenant Workspace administration](#16-tenant-workspace-administration)
17. [Platform administration and recurring operations](#17-platform-administration-and-recurring-operations)
18. [Incident handling, backups and recovery](#18-incident-handling-backups-and-recovery)
19. [Operating checklists](#19-operating-checklists)
20. [Common problems and their resolution](#20-common-problems-and-their-resolution)
21. [Final handover or termination of operations](#21-final-handover-or-termination-of-operations)

## 1. Operating rules and responsibilities

### The records that establish the financial position

ClassicFin Hub maintains an expected funds book, dated observations of real balances, source transaction records and independent review evidence. These have different meanings:

| Record or state | What it establishes | What to do with it |
| --- | --- | --- |
| Transaction request, quotation or instruction | The operation someone wants to record | Check the actual movement and complete the required review; saving an instruction alone does not settle it |
| Reviewed opening | The evidenced starting position of one real account | Establish it once from a real count, provider balance or statement, including a genuine zero |
| Posted funds movement | The internal book change and balanced journal | Use it for expected balances and posted cash impact |
| Actual balance observation | What a person or supported SMS saw at a stated time | Compare it with the book at that time; investigate any difference |
| Manual movement `pending_review` | A proposed financial posting with evidence | A different authorized person must approve or reject it |
| Manual movement `posted_manual` | An independently reviewed internal posting | Retain its reference, review and journal evidence; confirm external provider results separately |
| Provider email `accepted` | An email provider accepted a delivery request | Check the recipient mailbox separately if delivery matters |

Creating an account does not create funds. A missing opening is unknown, not zero. A new cash shift does not recreate yesterday's money. Funding from another recorded account transfers existing funds; it is not free money. A balance observation does not overwrite the book.

The application records manual financial evidence and supports separately licensed Android SMS capture. It does not execute live bank or mobile-network payments. Keep `REAL_MONEY_ENABLED=false` as required by the launch runbook. An approved indicative Forex rate is not a verified market feed. Do not tell customers that an internal status proves external settlement.

### Responsibility matrix

Every action also requires an active tenant entitlement, an active user, the relevant module assignment and the correct branch. A role cannot obtain extra financial authority by adding a module.

| Role | Primary work | Main limits |
| --- | --- | --- |
| Platform Super Admin | Publish plans; create tenants; grant or revoke entitlements; manage tenant status; review platform appointments, audit and background operations | Platform access is separate from tenant operating accounts; MFA is mandatory |
| Tenant Owner | Configure tenant, branches, staff, funds, defaults and policies; oversee tenant-wide activity; perform permitted operations and independent reviews | Cannot approve their own request, own opening evidence or assigned drawer evidence where independence is required |
| Branch Manager | Manage permitted staff in their branch; inspect branch activity; review permitted Banking, Forex, Transfer, expense and cash cases | Cannot publish tenant approval policies or grant owner/platform powers; cash variance approval needs Owner or Reconciliation Officer; not a Mobile Money transaction reviewer |
| Mobile Money Operator | Record cash-in and cash-out; inspect their transactions and Mobile Money reports; open and close their own drawer | Cannot independently approve their own records or reset wallet balances on the transaction form |
| Money Transfer Operator | Type sender and receiver details; request collection; check receiver/PIN and request payout | Collection and payout posting require another authorized reviewer |
| Banking Operator | Maintain permitted customer/accounts records and record deposit, withdrawal and account-transfer instructions | Instruction creation and financial posting are separate; Customer Accounts access is needed for customer ledger operations |
| Forex Operator | Propose rates; quote buy/sell operations; record manual exchange evidence | A different reviewer approves rates, quotes and financial movements |
| Reconciliation Officer | Independently review funds observations, movements, Mobile Money, Banking, Transfer, Forex, expenses and cash; investigate differences | Cannot review their own requests; operates within their assigned branch |
| Auditor | Read authorized tenant-wide financial evidence, reports, analytics and audit | Cannot create, approve or alter operating records |
| Reports Analyst / Analytics Analyst | View and export their authorized reporting sources | Reporting access does not grant operational details or access to unsubscribed/unassigned source modules |
| Approval Requester / Approval Officer | Submit internal business requests / decide configured approval stages | Internal approval does not execute a payment or replace financial review |
| Viewer | Limited Mobile Money viewing and their notifications | No financial posting or review |

Owners, Branch Managers, Reconciliation Officers, Auditors, Reports Analysts, Analytics Analysts and Approval Officers must complete MFA. Use individual accounts, not shared teller or reviewer credentials. Assign at least two independent people before trying to make the first reviewed posting.

### Branches, dates and currencies

- Transactions use the signed-in person's assigned operating branch. There is no transaction branch picker.
- The Tenant Owner and Auditor can switch the viewing control between Main, another active branch and All branches. Viewing another branch does not move a transaction there. Read the operating-branch indication before creating anything.
- An owner setting up a funds account must select a specific viewing branch. All branches is a reporting view, not a place to create an account.
- Financial reports, observed-at fields and appointment scheduling use UTC. Enter UTC when a field says UTC, even if the tenant profile holds a local timezone. Check device time synchronization, especially for SMS forwarding and MFA.
- Supported stored currency codes are UGX, USD, SSP and KES. The UI labels KES as KSH. Do not add different currencies into a single total or treat an indicative exchange-rate field as a currency conversion.

## 2. Platform installation and administrator access

**Responsible:** deployment operator, then Platform Super Admin.

1. Complete the [launch runbook](LAUNCH_RUNBOOK.md): real HTTPS domain, authenticated MongoDB replica set, private service configuration, indexes, tested immutable image, web and both worker services, monitoring and a verified restore rehearsal.
2. On a fresh installation, the deployment operator runs the documented `npm run bootstrap` procedure using the protected password-file method. Do not run bootstrap as an upgrade or as a routine password reset.
3. Open the canonical site's sign-in page and use the platform administrator account. Finish authenticator MFA enrollment and the required challenge before entering `/platform/dashboard`.
4. Store MFA recovery material in the organization's approved private custody location. Do not put passwords, recovery codes, phone gateway secrets, API keys, backup keys or complete environment files in chat, email tickets, screenshots or Git.
5. Confirm **Command Center → Dashboard**, **Product & Billing → Plans**, **Tenant Operations → Create Tenant** and **Administration → Audit Trail** are accessible to the administrator.
6. Check real invitation delivery, password recovery, account sign-in and MFA with a controlled test account. Essential security email does not depend on buying the Notifications module.

**Completion evidence:** the deployed services pass the runbook's read-only probes; the administrator has MFA; a test invite reaches the intended mailbox; a real offsite backup can be restored into an isolated rehearsal environment. A successful local test alone is not this production acceptance.

## 3. Products, plans and subscription pricing

**Responsible:** Platform Super Admin. **Pages:** `/platform/plans`, `/platform/modules`, `/platform/subscriptions`.

### Publish the manual plan first

1. In **Plans**, create a plan with a stable code, customer-facing name and description.
2. Enter the monthly and yearly USD prices, trial duration, included modules and capacities: users, branches, transactions per month, SMS per month and storage metadata.
3. Include all prerequisites for the work being sold. For example, Banking customer ledger work requires Customer Accounts; automatic Mobile Money capture requires both Mobile Money and SMS Capture. Include Customers where that customer workflow is needed, and assign the necessary modules to staff later.
4. Save the draft, review its values, then publish with a meaningful reason. Only a valid published version is available for tenant creation. Draft changes do not silently change existing customers' contracts.
5. Confirm the new plan appears in **Create Tenant → Plan** and, where applicable, the public pricing presentation.

If **Create Tenant** has no plans, use **Set up plans and continue** to publish the initial catalogue, or finish publishing an appropriate plan in Plans. Do not keep pressing Create on an empty Plan field.

### Sell Android capture at a higher price

1. Create the equivalent manual plan first.
2. Create its automatic counterpart and choose **SMS-assisted + manual entry**.
3. Link the manual counterpart; include Mobile Money and SMS Capture; enter a positive SMS allowance.
4. Match the corresponding non-SMS modules, user/branch/transaction/storage capacities. Set both monthly and yearly prices strictly higher than the manual counterpart.
5. Publish and verify both versions. When increasing both products' prices, publish the higher SMS prices before increasing the matching manual plan enough to violate the premium relationship.

Manual entry remains available to an SMS-assisted tenant. A full SMS quota does not convert manual entries into SMS or prevent otherwise permitted manual work. SMS Capture cannot be used as a cheap independent add-on to bypass the required premium plan.

### Understand what a grant means

Published plan versions and granted subscription terms are retained as snapshots. Publishing a new version does not automatically migrate current subscribers. A plan with no trial can create an invited tenant without giving it an operating term; grant the approved term before opening operations.

**Grant / renew subscription** is an audited manual entitlement action, not a charge, paid invoice, bank collection or automated renewal. Follow the organization's separate commercial payment procedure, then record the authorized entitlement with its reason. Storage allowance is catalogue metadata; it is not a general arbitrary-file upload service.

## 4. Create and activate the first tenant

**Responsible:** Platform Super Admin creates; Tenant Owner accepts. **Page:** `/platform/tenants/create`.

1. Enter **Tenant name**, optional **Slug**, **Owner**, **Owner email**, optional **Phone**, and the published **Plan**. Check the email carefully; it identifies the invited owner.
2. Choose **Create tenant and private invitation** once. Read the resulting validation or success message. If the connection fails, inspect Tenants and the owner's email before submitting another request for the same business.
3. Open the new tenant profile in **Tenants**. Check its plan version, entitlement end, branch allowance, reserved seats and status. Confirm provisioning completed rather than assuming a saved form is an operational tenant.
4. If no operating term exists, use the tenant profile's **Grant / renew subscription**, choose a published plan, enter the authorized duration of 1–366 days and a 20–600 character justification.
5. Deliver any private invitation only through the intended approved channel. The owner opens the single-use invitation, sets a strong password and signs in. Expired or used invitations need the permitted replacement/recovery workflow; copying a used link does not reactivate it.
6. The owner enrolls and completes MFA, opens **Tenant Workspace → Tenant profile**, and verifies the business details and Main branch.
7. Create the independent operating and reviewing accounts described in the next section. Finish funds setup before the first transaction.

**Expected result:** a platform tenant mapping and subscription, a tenant database with provisioned indexes, a Main branch and owner identity, invitation/audit evidence and an activated owner account. This creates the organization, not its cash or wallet balances.

## 5. Tenant profile, branches and staff

**Responsible:** Tenant Owner; permitted staff management can be delegated to a Branch Manager for their branch.

### Profile and branch setup

1. Open **Tenant profile** at `/tenant/workspace/profile`. Check legal/display name, contact details, country, timezone and supported operating currency. Save and confirm the saved revision. A configured owner contact email is not a transfer of login ownership.
2. Open **Branches & locations** at `/tenant/branches`. Retain and verify Main; add only genuine operating locations within the active allowance.
3. Give each branch a unique code, clear name, correct currency and address. Treat currency selection as permanent for the branch's existing financial records.
4. Select Main or the intended branch when reviewing its setup and balances. Staff transactions will follow their persisted assignment, not the owner's viewing selector.
5. Before archiving a branch, resolve its pending reviews and invitations and reassign active staff as required. Keep the historical branch and records; archiving is not deletion.

### Invite and assign staff

1. Open **Admins, tellers & users** at `/tenant/users`.
2. Invite each person with a unique email, their actual active branch, appropriate fixed role and only the subscribed modules needed for that role. A pending invite reserves a seat.
3. The recipient accepts their single-use staff invite within its 24-hour validity, creates a password and completes required MFA. Cancel obsolete pending invitations rather than leaving seats reserved indefinitely.
4. Have each person sign in and check their own menu and branch. Missing menu items normally mean entitlement, assignment or permission is missing; adding a bookmark does not grant access.
5. Assign an independent Tenant Owner, Branch Manager or Reconciliation Officer with the appropriate review permission and source modules. For Mobile Money transaction review use a Tenant Owner or Reconciliation Officer. Do not plan an operation where the only reviewer is its originator or the person assigned to that cash drawer.
6. On role, branch or module reassignment, tell the person to sign in again. Security changes invalidate existing sessions. Restore a disabled account only after checking seat capacity, branch and assignments.

**Expected result:** individual identities tied to actual branches and allowed modules, auditable invitations and changes, and enough independent people to operate the review gates. **Roles & permissions** is a reference to fixed server permissions, not a custom role editor.

## 6. Set up real wallets, cash, bank funds and stock

**Responsible:** Owner creates accounts and defaults; operators/authorized staff submit real observations; an independent authorized reviewer approves them. **Page:** **Wallets & balances**, `/tenant/treasury`.

### Choose the right account type

| Account kind | Represents | Setup guidance |
| --- | --- | --- |
| `cash` | An actual operator's physical drawer | Assign the real operator; separate tellers need separate drawers |
| `wallet` | A provider Mobile Money wallet/e-float balance | Choose its actual network/currency and safe identifier; never enter its PIN |
| `bank` | An actual bank or settlement funds account | May be shared within the branch; this is distinct from a customer's deposit-account liability |
| `forex_stock` | Physical foreign-currency inventory | Create a separate account for each needed currency and submit a stock count |
| `transfer_clearing` | The amount owed for collected, unpaid transfers | Normally use a shared branch payable account so multiple authorized tellers can handle the same branch's transfers |

Bank funds accounts can support payment/funding even without a Banking operations subscription. Customer Banking operations additionally need the Banking and Customer Accounts access described below. A branch having one drawer does not mean every teller has a usable drawer.

### Establish an opening once

1. As Owner, select the account's actual branch in the viewing control, then choose **Add account**.
2. Enter **Account code**, **Account name**, **Account kind**, **Currency**, applicable **Wallet network**, **Assigned operator**, safe **Wallet / bank identifier** and whether it is **Default for this operation**. Choose **Create account**.
3. Open that account. Under **Submit actual opening balance**, enter the amount actually counted or shown, **Observed at (UTC)**, the matching **Evidence type**, **Evidence reference** and **Evidence explanation**. Use a genuine dated statement/count reference. Submit evidence for independent review.
4. A different eligible reviewer independently inspects the source, opens the account or **Independent review**, writes the evidence review and chooses **Approve evidence** or **Reject evidence**. A person cannot approve evidence for their own assigned drawer.
5. Verify **Expected book balance**, **Last reviewed actual balance**, **Difference at observation** and control state. Confirm the account is active with a reviewed opening and matched state before spending from it.
6. Repeat for each real wallet, settlement account, teller drawer, required Forex stock and shared transfer payable. A genuinely empty new payable or stock account still needs a reviewed zero opening. Existing liabilities require the actual outstanding register balance, not an invented zero.

Creating a customer account is different from establishing real assets. Do not create matching fake cash, wallet or bank openings just to make a customer balance appear affordable.

### Set defaults and fee policy here

Open **Account settings** to name the account, mark the default for matching future operations and configure wallet **Fee / commission treatment**:

| Choice | How it affects the internal books |
| --- | --- |
| Record fee only | Keeps the entered fee as information; does not move cash/wallet funds for that fee |
| Fee collected from customer | Cash-in customer pays amount plus fee; cash-out customer receives amount less fee; actual collected fee is posted |
| Commission credited to wallet | Records an explicit commission actually credited to the provider wallet |

Choose the treatment that matches the actual contract and evidence. It applies to future entries; prior transactions retain their original policy. Daily Mobile Money entry selects the wallet and uses configured matching payment-account defaults. Do not re-enter the wallet's opening or actual balance for every transaction.

If a form was opened before the owner changed a wallet policy, refresh it and check its summary before submitting. Do not compensate for a stale policy by changing the amount or inventing another transaction.

### Add funds from an existing account

1. At **Add funds**, choose **From account**, **To wallet / account**, **Amount**, **Funding reference** and **Note / narration**.
2. The accounts must be different, usable, in the same branch and the same currency. This supports cash, wallet and bank funding; it is not a cross-branch transfer or Forex conversion.
3. The source must have enough known funds. A cash source or destination needs its actual assigned operator's independently verified open shift. This funding flow cannot move funds directly between accounts assigned to different tellers; use only the eligible same-operator/shared-account combination shown and an approved separate custody procedure where needed. Perform and evidence the real-world transfer through the appropriate bank/provider/cash procedure.
4. Choose **Submit funding transfer**. A different reviewer checks the source/destination evidence and approves or rejects it.
5. After approval, verify the equal decrease at source and increase at destination in posted history. Check the actual provider or bank balance separately.

**Example:** a reviewed bank book of UGX 800,000 funds an MTN wallet with UGX 200,000. Approval makes bank UGX 600,000 and increases the wallet by UGX 200,000. Total recorded assets are unchanged. This action does not create a bank payment through an API.

### Check actual balances without resetting them

Use **Record actual balance check** when comparing a count, provider app or statement with the book. Record the exact observation time and evidence. A different reviewer reviews it. A mismatch places the account on hold; an observation itself does not change the ledger.

Investigate missing entries, duplicates, timing and exact reversals first. If a documented residual difference remains, use **Request audited adjustment** against the relevant reviewed checkpoint and provide a full justification. Another eligible person chooses **Approve visible adjustment** or rejects it. The adjustment is separately visible through suspense; do not hide a shortage by entering a replacement opening.

See [manual funds and UI controls](MANUAL_FUNDS_AND_UI.md) for the detailed account, fee and reconciliation contract.

## 7. Open the operating day

**Responsible:** each cash-handling operator; another eligible reviewer verifies the opening. **Page:** **Operation Reports → Open day**, `/tenant/cash/shifts`.

1. Confirm you are signed in as yourself at the correct operating branch, with the needed subscriptions and module assignments.
2. Check **Wallets & balances**. Your drawer and required accounts must have reviewed openings, adequate funds and no unresolved hold. Compare real wallet/bank balances and count the drawer before accepting work.
3. Enter the physical **Opening** count and choose **Open day with these balances**. This submits `pending_open`; it does not yet authorize cash posting.
4. An independent reviewer opens the shift, records **Opening verification evidence**, recounts/checks the evidence and chooses **Verify and open shift**. If wrong, use **Reject opening count** and correct the opening process.
5. Confirm the shift is `open` before starting cash transactions. The actual drawer book must agree with the opening; the shift does not reinitialize the account.
6. Open **New transaction** to choose an available service. Keep the correct originating form/reference for each real event.

Only one unfinished drawer session is allowed for the applicable operator/branch. Resolve yesterday's open, submitted or disputed work instead of creating another opening to bypass it. Noncash activity still needs its actual bank/wallet funds and the relevant source workflow.

## 8. Mobile Money: manual entry and Android SMS

**Responsible:** Mobile Money Operator creates; Owner or Reconciliation Officer reviews. **Pages:** **Cash-in**, **Cash-out**, **Network activity**, **Cash impact**, **Mobile money report**.

### Manual cash-in and cash-out

1. Open `/tenant/mobile-money/cash-in` or `/tenant/mobile-money/cash-out` for the real operation.
2. Select the correct network, wallet if more than one eligible wallet exists, customer details, actual amount, fee, payment method and provider/reference information shown on the form. Verify the auto-selected account and currency summary.
3. Use a unique real provider reference. A duplicate real event is not a new transaction simply because the first browser response was lost.
4. Verify the external event through the provider's permitted procedure, record it once and retain the resulting reference/acknowledgement. Check its actual status before telling the customer it is complete.
5. The independent reviewer checks the source evidence, amounts, fee policy and funds movement before accepting the record. Resolve pending verification, corrections or voids before drawer close.
6. Check **Network activity** for its network/source/status, **Cash impact** for posted physical-cash movements and **Mobile money report** for the filtered record/fee totals. Manual and SMS source tags remain visible.

Mobile Money differs from the separate Banking, Forex and Transfer manual-movement queue: a valid funded Mobile Money recording posts its internal funds movement when recorded, while the record remains `pending_verification` for independent evidence review. Accepting or disputing that review does not post a second movement or certify provider settlement. An approved source void appends the exact reversal. Inspect both the posting and review state before retrying or correcting an event.

Cash-in reduces provider e-float and increases the selected payment asset; cash-out increases e-float and reduces the payment asset. Internal **Wallet Balance** payment requires an eligible customer account and affects its liability instead of physical cash. Bank payment affects bank funds instead of the drawer. Read the fee treatment: an informational fee is not automatically collected income.

**Balanced cash example, fee collected from customer:** start with reviewed cash UGX 300,000 and wallet UGX 700,000. Record cash-in UGX 100,000 with a genuinely collected UGX 1,000 fee. Posted cash becomes UGX 401,000; wallet becomes UGX 600,000; UGX 1,000 is fee income. A later cash-out UGX 40,000 with a collected UGX 500 fee pays the customer UGX 39,500: cash becomes UGX 361,500 and wallet UGX 640,000. Total assets exceed the original UGX 1,000,000 by the UGX 1,500 fees actually collected. With **Record fee only**, those fees do not change balances or become realized income.

### Enroll an Android phone or SMS gateway

**Prerequisites:** the SMS-assisted plan, positive allowance, Mobile Money and SMS Capture assigned to the operating user, correct active branch, verified funds and cash shift if needed.

1. Open **SMS Capture** at `/tenant/sms-capture` with the authorized operating account.
2. Enroll the device for the correct operator, network and exact approved sender allowlist. Give it a useful nonsecret device name.
3. Copy the device secret once into the private Android relay configuration. Follow [Android relay instructions](../tools/android-sms-relay/README.md) on the phone; use the actual HTTPS application URL. Never paste the secret into Workspace integration notes or support chat.
4. Send a controlled, anonymized test in the supported message format. Inspect the inbox and compare the parsed direction, amount, currency, fee, customer and provider reference with the original message.
5. Enable automatic recording only after the actual network wording is supported and the account/shift/review controls have been tested. Unsupported or ambiguous messages stay for review; the system must not guess missing financial details.
6. During operations, monitor accepted, duplicate, unsupported, queued and failed items. Manual entry remains available. Before manually recording an event, search the provider reference so a queued SMS cannot cause a duplicate business event.
7. Revoke a lost/replaced device promptly and enroll its replacement with a new secret. Disabling the user, changing their branch/role/assignment or removing entitlement can block queued capture and final posting.

The conservative supported profile includes messages such as `MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Jane Doe; Ref: ABC12345`. A supported explicit `Agent Balance` can supply a dated balance observation. Do not assume every native MTN/Airtel/bank SMS wording is supported, or confuse a customer balance with the agent wallet balance.

Gateway delivery uses signed messages, stable IDs, sender checks, replay limits and quotas. A queued old message cannot be attached to a later cash shift. Raw SMS is encrypted with the configured retention policy; treat phone access and private retry queues as sensitive. See [SMS and plan configuration](SMS_AND_PLAN_CONFIGURATION.md) for the enrollment and pricing contract.

## 9. Customers, accounts and Banking

**Responsible:** permitted customer/accounts staff and Banking Operator; a different Banking reviewer/Owner/Reconciliation Officer performs independent decisions. **Pages:** Customers directory, Accounts directory, Deposit, Withdraw, Account transfer.

### Set up customer records and accounts

1. Use **Customers directory → New customer** (`/tenant/customers/new`) for an actual customer when the workflow requires an internal customer record. Record accurate names, contact details and the evidence required by your business procedure.
2. Search before adding another record. Use **Customer logbook** for authorized history rather than creating duplicate customers for repeat work.
3. Use **Accounts directory → New account** (`/tenant/accounts/new`) to create the customer's eligible internal account with its correct supported currency, type/status and customer link.
4. Inspect **Account balances** and **Account movements**. A customer account represents what is owed to the customer; the Treasury bank/cash/wallet represents the asset backing it.

For Banking deposit, withdrawal or internal customer transfer, both the tenant and the user need the relevant Banking and Customer Accounts access. Merely saving a masked external bank reference does not create an internal customer balance or enable customer ledger posting.

### Deposit or withdrawal

1. Open **Deposit** (`/tenant/banking/deposit`) or **Withdraw** (`/tenant/banking/withdraw`). Choose the real customer account, amount/currency, payment channel and evidence fields on the form. Save the instruction and retain its reference.
2. Check and complete the instruction's independent review where required. An approved instruction awaiting execution is still not a posted account movement.
3. From its detail, choose the available manual movement action. Select the actual **Counted cash / settlement account** matching the channel and currency. For cash, it must be the originator's verified drawer.
4. Enter **Counted cash / statement reference** and **Manual movement explanation**, then **Record for independent review**.
5. The independent reviewer opens **Manual movement review** (`/tenant/funded`), checks the actual customer-account instruction, count/statement evidence and funds, and chooses **Approve and post manual movement** or **Reject**.
6. Confirm the posted manual movement, customer account movement and Treasury balance. The app has recorded the internal manual operation; any external bank processing must be checked with the bank separately.

**Balanced example:** depositing UGX 50,000 cash increases the real cash asset by UGX 50,000 and increases the customer's deposit liability by UGX 50,000. Withdrawing UGX 20,000 decreases both by UGX 20,000. A customer balance alone does not prove there is enough physical cash to pay a withdrawal.

### Transfer between internal customer accounts

1. Open **Account transfer** (`/tenant/banking/transfer`). Choose the actual eligible source and destination customer accounts and enter the amount and explanation.
2. Keep the accounts in the supported branch/currency context. Do not use this as an undocumented cross-branch or currency conversion mechanism.
3. Complete the instruction review and separately record/review its manual movement.
4. Confirm source customer liability decreases and destination customer liability increases by the same amount. No drawer or bank asset moves merely because one customer's liability was reassigned to another.

Use **Account movements** and **Banking report summary** to distinguish requested, approved-but-awaiting-posting, rejected/cancelled and posted manual operations. Do not add an external bank transaction a second time just because its internal instruction is still pending review.

## 10. Forex rates, quotations and manual exchange

**Responsible:** Forex Operator proposes and quotes; a different permitted reviewer approves. **Pages:** Buy forex from customer, Sell forex to customer, Active rate board, Forex cash impact, Forex operation records, Forex report summary.

1. At **Active rate board** (`/tenant/forex/rates`), propose the currency pair and rate with its intended validity/evidence. A different authorized reviewer approves or rejects it. The rate is indicative and internally approved; verify any market source through your own procedure.
2. Ensure the real **Foreign currency stock** and the local **Settlement account** have reviewed openings and enough funds for the chosen direction.
3. Open **Buy forex from customer** (`/tenant/forex/buy`) when receiving foreign currency, or **Sell forex to customer** (`/tenant/forex/sell`) when paying foreign currency to the customer.
4. Select the approved rate, enter the customer, amount, settlement method and actual fee. Check the displayed foreign and settlement amounts and the quote expiry. The quote retains the rate snapshot; a later rate change does not rewrite it.
5. Complete the required independent quotation decision. Before expiry, record its manual movement with the correct foreign stock, settlement account and count/statement reference.
6. A different reviewer checks both currencies, cash/stock counts, locked rate, fee and direction, then chooses **Approve and post manual movement** or rejects it.
7. Inspect both balances and the quote/movement record. Review **Forex cash impact**, **Forex operation records** and **Forex report summary** using the required filters.

**Example without a fee:** buy USD 100 from a customer at UGX 3,700 per USD. The posted manual exchange increases USD stock by USD 100 and decreases UGX settlement cash by UGX 370,000. A sell at the same rate reverses those asset directions. USD and UGX remain separate books and separate report totals; do not add them numerically. Review the actual fee summary before posting a fee-bearing exchange.

An expired or cancelled quote must not be treated as an executed exchange. Obtain a valid quote and correct review rather than editing historical rate values or entering a fake stock opening.

## 11. Money Transfer: sender entry through final payout

**Responsible:** Money Transfer Operator originates collection and payout; a different permitted reviewer posts each stage. **Pages:** Send money / Generate PIN, Payout by PIN, Pending payout queue, Money transfer record, Transfer fee summary, Transfer report summary.

### Prepare the branch and teller

- Set up the actual collection/payment funds and each teller's assigned drawer where cash is used.
- Open and verify cash shifts before cash collection/payout.
- Set up an independently opened **Transfer payable account** in the same currency. Use a shared branch clearing account when more than one teller will operate; an operator-assigned clearing account restricts who can use it.
- This implemented PIN payout is in the same operating branch as collection. Cross-branch remittance/payout is not implemented. Do not promise collection in one branch and payout in another, or change staff assignments to bypass that boundary.

### A. Enter sender and receiver directly

1. Open **Send money / Generate PIN**, `/tenant/money-transfer/send`.
2. Type **Sender name**, **Sender phone**, choose **Sender country**, and enter **Sender ID/document no.** where available/required by your operating procedure.
3. Type **Receiver name**, **Receiver phone**, choose **Receiver country**, and enter **Receiver ID/document no.** where available/required by your procedure.
4. Enter the remaining transfer details: actual payment method, purpose, amount, fee and **Request validity**. That validity limits how long the uncollected request can be used for collection; it is not a payout-PIN expiry promise. Check the branch currency and total the sender pays. Any displayed indicative exchange-rate field does not itself perform a Forex conversion.
5. Names are required, 2–120 characters. Phones are required international numbers beginning with `+` and country code, with 8–15 digits after normalization; the first digit must not be zero. Formatting spaces, dashes and parentheses are normalized. Choose a valid country from the supplied list. Identification-document fields are optional in the application and accept up to 80 characters; follow your actual identification procedure. Check the receiver's phone with the sender before saving.
6. Choose **Save transfer & continue**. You do not need to select or create a saved contact. The transfer saves immutable sender/receiver snapshots; typing a transfer does not automatically create reusable contact records.

The retained legacy contact-ID API is for compatibility with existing integrations/history. It is not a teller prerequisite. A request must not mix typed parties with contact IDs.

### B. Record and review the collection

1. On **Record manual movement**, choose **Collected funds account** and the shared **Transfer payable account** in the transfer's branch/currency.
2. Enter the actual collection voucher/statement reference and explanation, then **Record for independent review**. Saving the request alone has not made it payable.
3. Another authorized reviewer verifies the real collection, amount, fee and accounts, then chooses **Approve and post manual movement**.
4. Confirm the source transfer is `collected_manual`, the collection account increased, the unpaid amount is in the payable account and the item appears in **Pending payout queue**.
5. Use **Show payout PIN once** when authorized. Share it privately with the intended sender/receiver under your business procedure. Do not put the PIN into report notes, screenshots, audit descriptions or support tickets. It is intentionally not a repeatedly readable password.

### C. Check the receiver and request payout

1. At the same operating branch, open **Payout by PIN**, `/tenant/money-transfer/payout` (the payout form is `/tenant/funded/payout`).
2. Enter the six-digit **PIN** and the **Receiver phone** from the transfer. Choose **Check PIN**. The phone must match the immutable receiver record; do not substitute the sender's phone.
3. Follow the business's physical receiver-identification procedure. The UI also accepts **Receiver name check** and **ID / Passport presented** as optional fields. If a name check is entered, it must match the stored receiver name. The application does not authenticate a government document.
4. After the match, review the displayed transfer, currency, amount and receiver before continuing. Add the required **Payout note**, actual cash/statement evidence reference and the eligible payout account shown on the form.
5. Choose **Pay out cash** to submit the payout request for independent review. The button creates the reviewed-payout workflow; the success message is **Payout requested for independent review**, not proof that cash has already been handed over.
6. A different eligible reviewer checks the receiver verification, payable balance, drawer funds and physical-control procedure, then **Approve and post manual movement**. Follow your approved cash-handover procedure only with the required independent authorization and retain the receiver's voucher.
7. Confirm payout is posted, the payable is reduced, the paying account is reduced and the transfer no longer appears as an unpaid collectible amount. A PIN cannot authorize a second payout.

The successful PIN/phone check creates a five-minute verification tied to the checking operator. If it expires before the payout request, check the PIN again; changing the operator or branch does not carry that verification forward. The original request expiry is checked before collection and does not establish a separate expiry of an already-collected transfer's payout PIN.

**Balanced cash example:** a sender transfers UGX 100,000 and pays a UGX 2,000 fee. Reviewed collection increases cash by UGX 102,000, transfer payable by UGX 100,000 and fee income by UGX 2,000. Reviewed payout decreases the paying drawer by UGX 100,000 and clears that UGX 100,000 payable. Across the branch, assets increase by the retained UGX 2,000 fee, with no unpaid liability left for this transfer. Two teller drawers can carry the collection and payout only when both are correctly configured in this same branch and the clearing account is accessible to both.

### Exceptions

Wrong, already-consumed or wrong-branch PIN lookups must not be bypassed by creating a duplicate transfer. Use **Check a different PIN** for an incorrect lookup, or repeat the check if the five-minute verification expired. An expired uncollected request needs a valid new instruction before accepting funds. Inspect transfer/movement history and escalate unresolved cases to the Owner/Reconciliation Officer. Do not claim there is a self-service PIN recovery, cross-branch payout or automatic provider remittance when the UI does not provide it. For an approved collection requiring an exceptional return/refund, preserve the original evidence and use the approved support/reconciliation procedure; do not overwrite the transfer or invent a replacement opening.

## 12. Expenses, corrections and voids

**Responsible:** permitted operator creates; a different expense reviewer decides; correction/void authority depends on the role. **Page:** **Add expense**, `/tenant/expenses/new`.

1. Enter **Expense type**, amount, actual **Payment method**, **Paid to / vendor**, reference and description. The branch and currency follow your operating branch.
2. Choose **Add expense**. It begins `pending_review`; pending requests do not reduce funds. A cash expense binds to the originator's verified open shift.
3. The reviewer opens the record, chooses the actual eligible funds account if not already determined, checks the real voucher and adds a meaningful **Review note**.
4. Choose **Approve expense** or **Reject expense**. Approval posts the balanced book movement and reduces the real source exactly once. Bank/Mobile Money expense recording does not send the external payment through a provider API.
5. Confirm the approved expense, funds movement and cash impact. Retain the actual receipt under the organization's record policy.

For a mistake, open the original record and choose **Request correction** or, where authorized, **Request void** with an explanation. A different eligible reviewer chooses **Approve request** or **Deny request**. Corrections append reversal and replacement postings; voids append reversals. Original values and audit history remain visible.

Mobile Money has its own source review and correction/void controls; use those on the original record. Do not use an unrelated expense or funds opening to conceal a wrong Mobile Money transaction. Submitted/reconciled drawers cannot be silently changed by later expense correction. Resolve the actual record state with the reviewer; preserve evidence rather than editing database documents.

## 13. Approvals and notifications

### Internal approval requests

**Responsible:** Owner publishes policies; requesters submit; the specified independent role decides. **Page:** **Approvals & corrections**, `/tenant/approvals`.

1. With Approval Workflows licensed/assigned, the Owner publishes a policy with a unique code, name, category, 1–3 ordered reviewer roles and deadline.
2. Submit the actual general, procurement, operational-exception or policy-change request using the correct active policy and branch.
3. Each configured stage must be decided by an eligible person holding that exact role and module assignment. A requester cannot approve their own request; one person cannot participate twice in the same chain.
4. Review the result and complete the underlying authorized work through its real operational screen. An approved business request does not release funds, reverse a journal, alter a subscription or skip mandatory financial review.
5. Cancel obsolete pending requests where permitted. Expired, rejected, cancelled and approved requests retain history. New policy versions do not rewrite requests already submitted.

### Staff notifications

**Responsible:** Owner manages templates; Owner/authorized Branch Manager sends; each recipient manages preferences. **Page:** **Notifications center**, `/tenant/notifications`.

1. Owner publishes an appropriate plain-text template. Only the allowed name variables are substituted. Retiring a template does not erase previously sent messages.
2. Choose an authorized active recipient and template, review the content and send once. Owner can send tenant-wide; Branch Manager stays within their allowed branch recipients.
3. Recipient reads the in-app inbox. Optional email needs recipient opt-in, a template permitting email and a working configured worker/provider.
4. Inspect email state accurately: pending/processing/retry is queued work; accepted means provider acceptance only; dead needs investigation; suppressed means the current recipient/access/preference blocks sending.
5. Owner may audited-requeue a dead letter after fixing the actual cause. Do not repeatedly requeue an inactive or opted-out person.

Saving **Notification rules** in Workspace records configuration descriptions; it does not create an automatic rule scheduler. The actual send/template/inbox workflow is in Notifications. SMS Capture receives provider transaction evidence; it is not an outbound customer SMS or WhatsApp notification service.

## 14. Reporting and owner oversight

**Responsible:** Owner, permitted reviewers/auditors and assigned analysts. **Pages:** Operation Reports; module-specific report pages; Remote owner dashboard/Advanced Analytics when subscribed.

1. Choose Main, a specific branch or All branches if your role permits. Verify that scope before interpreting totals. Branch staff remain in their own authorized scope.
2. Select **From (UTC)** and **To (UTC)** and the available network, currency, source and status filters. Apply filters explicitly. Do not compare a UTC financial day with an unconverted local-day statement.
3. Use the report suited to the question:

| Report | Operational question |
| --- | --- |
| Today snapshot / Daily business report | What happened in the authorized view today? |
| Opening cash | Which openings were submitted and independently verified? |
| Closing cash / expected cash | What was expected, physically declared and different? |
| Transaction summary | Which module/source/status amounts were recorded? |
| Expenses report | What is pending, approved, rejected, corrected or voided? |
| Transfer report / Transfer fee summary | Which collections/payouts remain pending and which fees were recorded? |
| Mobile report / Network activity / Cash impact | Which network/manual/SMS records and posted cash movements explain the Mobile Money position? |
| Account balances / Account movements / Banking report | What is the customer liability and which instructions actually posted? |
| Forex report / cash impact / records | Which currency positions, rates, quotes and manual exchanges explain stock and settlement? |
| Remote owner dashboard / Advanced Analytics | How do authorized aggregate sources compare across the selected scope? |

4. Distinguish pending records and informational fees from posted money/income. Cash impact uses actual posted movements, fees and reversals. Historical untracked records can appear separately; their existence does not establish a fabricated funds opening.
5. Use **Export CSV** or the module's CSV export when authorized. Export follows the same filters, branch and source permissions; detail exports are bounded to 5,000 rows. Narrow the date/source range if necessary. Use **Print report** for the printable view; browser printing is not a server-generated PDF report service.
6. Store exports in controlled business storage. They can contain personal and financial information. CSV formula neutralization does not make a file public-safe.
7. Use **Tenant audit activity** (`/tenant/audit`) to trace who changed or reviewed a record. Platform audit is separate. Quote references and times in an escalation, not secrets or complete customer datasets.

Reports and Analytics are separately entitled. A Reports subscription never grants a user's access to an otherwise unavailable operational source. Aggregate analysts may see grouped expense/approval/notification counts without vendor details, request descriptions or message bodies.

## 15. Close the day and resolve differences

**Responsible:** originating operator submits; independent reviewer reconciles; Owner or Reconciliation Officer approves a cash variance. **Pages:** Close day `/tenant/day/close`, Cash control review `/tenant/cash/shifts`, Wallets & balances `/tenant/treasury`.

1. Stop starting new drawer work while counting. Check pending Mobile Money verification/corrections, expenses and manual financial movement requests for your drawer. Have reviewers decide them or resolve/reject the source requests through their actual workflow.
2. Recheck real wallet/provider and bank evidence for the intended close time. Record new actual observations where needed and make their time clear.
3. Open **Close day** or your open shift. Inspect expected cash, count the physical cash independently from the displayed expected amount and enter **Physically counted closing cash**. Explain any difference.
4. Choose **Submit shift for independent review**. The shift becomes `submitted`; unresolved bound financial requests can block submission. The system checks the drawer's expected balance against its posted funds book.
5. Another eligible reviewer inspects the count, sources, expected amount and evidence. Choose **Approve count** if supported or **Dispute and return to operator** if investigation/recount is needed. A Branch Manager cannot approve a nonzero variance; a Tenant Owner or Reconciliation Officer must decide it.
6. If disputed, the originating operator follows the investigation/recount procedure and resubmits. Do not create another shift or change the opening to make the difference disappear.
7. If a Treasury checkpoint shows a difference, follow the explicit missing-entry/reversal/adjustment procedure from section 6. Approving a physical count is not permission to silently replace a wallet or drawer's book with that number.
8. Confirm the final approved shift, reviewed balances, no unresolved operational items and the saved daily report/export. Retain count sheets and vouchers according to policy, then sign out and secure the physical assets.

**Expected result:** an immutable recorded opening, posted event history, physical closing count, variance and independent decision. The next day starts from the existing funds book; no second opening journal is created merely because the date changed.

**Difference example:** expected cash is UGX 361,500 but a genuine count is UGX 360,500. Record the UGX 1,000 shortage and evidence. Search the event sequence, real vouchers and reversals; recount. If the shortage remains and the authorized policy allows recognition, request a visible independently reviewed reconciliation adjustment. Never change the cash-in amount solely to force a match.

## 16. Tenant Workspace administration

**Responsible:** Tenant Owner manages; authorized staff view their permitted controls. **Entry:** `/tenant/workspace`.

Use Workspace to check recorded operational setup and follow the linked account, queue, staff and subscription actions. Resolve a blocked item on the screen that owns the record, then refresh the readiness view. Its branch/module scope is still subject to your role and subscription. A branch-level funds check does not replace each teller's own account and shift checks. A ready setup indicator is not a promise that an arbitrary next transaction is affordable: the actual amount, liquidity, current ledger, source permissions and independent-review rules are enforced again when posting.

### Use Operational readiness and the daily queues

1. Read **Operational readiness**: **Setup required**, **Attention required** or **Setup checks complete** in the selected Main/branch/All scope. A setup check reports the saved configuration and current reviewed records; it does not query live provider balances or certify ledger integrity.
2. Resolve the linked active-branch, operating-staff assignment, privileged-MFA or subscription blockers first.
3. For each subscribed operation, check that the branch has an actual operating teller, a distinct eligible reviewer and the required reviewed funds path. Check each teller separately. Owner is counted as a daily teller only when no dedicated teller exists or the Owner has their own operating funds configured.
4. Transfer readiness needs the shared payable plus the teller's reviewed cash and independently verified shift for collection and payout in that same branch. Banking needs the assigned Customer Accounts access for teller/reviewer and a real eligible customer/internal account with the required liability mapping. Forex needs an unexpired approved indicative pair, foreign stock and settlement funds.
5. Use the daily queues to reach pending opening/checkpoint observations, funding, adjustments, shifts, Mobile Money, manual movements, rates and expense review/corrections. Follow the direct record link, such as the oldest pending manual movement, and inspect its actual source evidence before deciding.
6. Return to Workspace and refresh after completing a source action. A setup check can be complete while a particular amount is unaffordable or an account requires a new actual balance comparison; the transaction's posting controls still decide whether it can proceed.

The **Tenant profile** page includes the same operational hub, the business-identity edit dialog and the wallet setup/default/funding/reconciliation guide. Policy/content records are secondary configuration references, not a replacement for these real operating screens.

| Workspace area | Real work to perform | Boundary to remember |
| --- | --- | --- |
| Tenant profile | Business/contact/currency/timezone details; understand wallet-operation guidance | Contact metadata does not change the owner's login credentials |
| Wallets & balances | Actual account setup, defaults, fee policy, reviewed openings, funding and reconciliation | Transactions do not reset wallet balances |
| Branches & locations | Maintain actual locations and permitted status changes | Viewing a branch does not change the originating transaction branch |
| Admins, tellers & users | Invite, assign, disable and restore permitted people | Roles are fixed; modules restrict rather than extend role authority |
| Roles & permissions | Check what each fixed role can do | Not an arbitrary permission editor |
| Landing setup / Landing preview | Configure supported public sections and inspect the resulting public page | Publish only approved public contact/business content |
| Branding & receipts / Receipt preview | Maintain permitted colors, receipt wording/prefix/template fields and inspect output | A receipt acknowledges the recorded state; it is not external payment certification |
| Customer/KYC setup | Record the organization's KYC field descriptions/procedures | These descriptions do not create automatic transaction acceptance or government-ID validation |
| Subscription & limits | Inspect active entitlements, term and usage; submit supported module requests | Owner cannot grant themselves a paid entitlement or mark an invoice collected |
| Notifications center | Actual inbox, templates and authorized sends | Workspace Notification rules are descriptive configuration, not a scheduler |
| Integrations & API | Keep safe integration descriptions and operational references | Store no credentials here; enroll Android devices in SMS Capture |
| Import/export data / Tenant database | Use actual available workspace JSON/audit/customer/report exports and inspect permitted metadata | Historical draft data-job records are read-only; there is no creation/import worker, arbitrary database upload, Excel/PDF job or database editor |
| Compliance controls | Record local operating policies and responsibility | A policy description is not a programmable risk engine or automatic enforcement rule |
| Configuration audit (`/tenant/workspace/audit`) | Trace Workspace configuration changes | This scope contains Workspace events; use Tenant audit activity (`/tenant/audit`) for financial operating changes and decisions |

The customer portal is not an operational feature unless an actual enabled module and working implementation are available. Do not send a preview link to customers as if it provides live balances or customer self-service. Keep public landing content separate from private dashboard, personal data and secrets. Private financial pages are excluded from indexing; public content and published product facts should be reviewed for accuracy before launch.

## 17. Platform administration and recurring operations

### Daily platform control

**Responsible:** Platform Super Admin and deployment/on-call operator.

1. Check **Command Center → Dashboard** (`/platform/dashboard`) for tenant status and recent activity.
2. Check **Background Operations** (`/platform/operations/queue`) for stalled/retry/dead work. Read the cause before the permitted audited retry; do not create a second tenant because an invitation email is queued.
3. Check both worker heartbeats and configured delivery/backup/availability alerts using the runbook. A responsive web page does not prove workers or backups are healthy.
4. Review relevant **Audit Trail** entries (`/platform/audit`) for entitlement, status, invite, appointment and administrative changes.
5. Review **Module Requests** (`/platform/modules/requests`); confirm the commercial agreement and dependencies, then use the tenant's audited module grant procedure or reject with a reason. A request is not an automatic purchase.

### Appointments and onboarding handoff

1. Open **Appointments** (`/platform/appointments`), filter status and search by business/contact/email as needed. Use older-record pagination for history.
2. Confirm or reschedule with a future UTC time, permitted optional HTTPS meeting link and a meaningful audited note. Appointment updates use revision checks; refresh a stale page before deciding again.
3. Contact the requester through the approved channel. Saving the appointment decision does not automatically send a scheduling email.
4. After a confirmed appointment has started, record completion when it is actually completed, or cancel according to the real outcome. Do not mark a future appointment complete.
5. Use the completed appointment's **Create tenant** handoff if appropriate, then follow sections 3–6. An appointment does not provision a tenant by itself.

### Subscription renewal and quotas

1. Before term end, open **Subscriptions** (`/platform/subscriptions`) and the tenant profile. Confirm the agreed plan version/price and the actual commercial payment outcome outside the entitlement screen.
2. Review current reserved seats, active branches and module dependencies before changing capacity. Pending staff invitations consume reserved seats.
3. Use **Grant / renew subscription**, choose the intended published plan, authorized duration and justification. Confirm the new recorded term and audit entry. Existing customers do not inherit new plan versions just because you published one.
4. Where supported, grant a standalone module with its duration, seat/branch capacities and appropriate monthly record allocation. Transaction/customer/account/expense modules need positive record allocation; report/control modules use zero. SMS Capture follows the premium plan rule rather than an independent bypass.
5. Revoke subscription or a standalone grant only with an approved reason and operational handoff. Tenant suspension is a separate status workflow: granting an entitlement does not reactivate a suspended tenant.
6. Notify the tenant of access changes through an authorized communication channel. Check staff assignments again; a tenant having a module does not assign it to every user.

Usage periods are UTC calendar months. Creation reserves usage transactionally; identical retries do not intentionally consume quota twice. A quota error is not a reason to delete old records, change the clock or create another business event. Check the current plan/grant and usage, resolve an approved capacity change with the platform administrator or wait for the correct new period. Renewal/grant actions and their quota generations are audited; do not promise undocumented rollover, refunds or automatic billing.

### Weekly and month-end control

- Review pending reviews, held funds, disputed/submitted shifts, unpaid transfers, expiring quotes/requests, dead notifications and obsolete invitations.
- Compare bank/provider/stock evidence with the actual funds books; investigate unexplained differences and aged payables.
- Review active staff, role/branch/module assignments, MFA enrollment, Android devices and terminated employees' access.
- Review trials/terms, capacity and outstanding commercial agreements before expiration.
- Export and retain approved monthly reports by currency/source/branch, together with independent-review and reconciliation evidence.
- Check backup freshness, offsite retention, alert delivery and the next restore rehearsal.

There is no blanket month-end button that automatically reconciles providers, bills subscriptions, imports statements or executes pending transfers. These are controlled operational checks on the actual workflows above.

## 18. Incident handling, backups and recovery

**Responsible:** originating operator reports; Owner/Reconciliation Officer assesses the financial effect; deployment/on-call operator handles infrastructure; Platform Super Admin handles platform access and entitlements.

### When a save appears to do nothing

1. Keep the original reference and screen state. Check visible form errors, required fields and the saved record/history before submitting another event.
2. Search the real provider reference and inspect whether the record exists, is pending review or actually posted. A network timeout is not proof of rollback.
3. If a browser session/CSRF challenge expired, sign in again and reopen the current form. Check for the original record first.
4. Escalate with the UTC time, tenant/branch, module, record reference, observed message and request ID if shown. Include redacted evidence, not the user's password, PIN, SMS secret, raw credential-bearing configuration or a full customer export.

### Financial discrepancy or duplicate suspicion

Pause use of the affected account when evidence is uncertain. Preserve the original source, manual request, review and journals. Compare actual event time, recorded time, source reference, fee policy and account. Use exact source correction/void and independent reconciliation controls where available. Never delete ledger documents or manually edit a persisted balance to clear an alert.

### Lost phone, compromised account or wrong access

Disable/reassign the affected user through the authorized staff workflow and revoke the Android device where relevant. Preserve evidence and investigate queued transactions before re-enrollment. Role/module/branch changes revoke sessions, but still verify that the affected person/device can no longer act. Follow the organization's MFA recovery and security-incident process; do not share another user's login as a workaround.

### Service or database outage

Stop claiming new transactions are accepted until their persisted status is known. Secure physical cash and vouchers; use only an explicitly approved offline business procedure. Do not run database resets, development seeds or integration test scripts on production to repair availability.

The deployment operator follows the [launch runbook](LAUNCH_RUNBOOK.md) for read-only health checks and recovery. Useful categories are production configuration/live probes, infrastructure, financial/ledger consistency, outbox worker, notification worker, backup freshness and offsite/alert checks. The runbook contains the actual `production:check`, `infra:doctor`, `ledger:doctor`, `financial:doctor`, `worker:doctor`, `notification:doctor`, `backup:doctor`, `offsite:doctor` and `ops:doctor` procedures and their required private configuration.

An application rollback changes the tested application image only when storage compatibility permits; it does not roll back the database. Restoring a backup is an incident action with an approved target, encryption-key custody, known recovery point and reconciled business impact. Rehearse against an isolated environment with outgoing email/SMS/provider credentials disabled. Restore platform and all relevant tenant databases together using the approved topology-specific procedure. Verify recent references, identities, tenant mappings, balances, journals, indexes and audit history before reopening.

For each incident record the start/end UTC times, affected tenants/accounts, last known good reference, actual impact, decisions, responsible people and recovery evidence. After recovery, reconcile all queued/manual/offline events against the book before replaying anything. Test real alert receipt and missing-heartbeat detection; a configured alert URL is not evidence that someone received it.

## 19. Operating checklists

### First tenant launch

- [ ] Production domain/TLS, private configuration, indexes, web/workers and real mail are accepted against the launch runbook.
- [ ] A usable encrypted offsite backup and isolated restore rehearsal are recorded; on-call alerts reach a responsible person.
- [ ] Platform administrator MFA and recovery custody are complete.
- [ ] Correct manual/SMS-assisted plans are published with valid dependencies, capacities and premium pricing.
- [ ] Tenant owner invitation is accepted; entitlement term/status and owner MFA are correct.
- [ ] Main and other genuine branches have the intended immutable currencies and limits.
- [ ] Real operators and independent reviewers are active, individually assigned, MFA-ready and able to sign in.
- [ ] Each teller has the correct drawer; shared wallet/bank/stock/payable accounts are configured where needed.
- [ ] Each real opening, including a genuine zero, has actual evidence and independent approval.
- [ ] Defaults and wallet fee treatment match actual business practice.
- [ ] A verified open shift and a controlled end-to-end transaction, independent review, report and close have been accepted for every subscribed operating module.
- [ ] If licensed, the real Android device/profile, sender allowlist, duplicate behavior and revoke procedure have been accepted; manual entry also works.
- [ ] Public landing, receipt wording, owner oversight, filters and exports are reviewed without exposing private information.
- [ ] Staff know escalation contacts, cash custody and the day-end procedure.

### Every day: operator start

- [ ] Sign in as yourself; verify the operating branch and available modules.
- [ ] Count your real drawer; compare required wallet/bank/stock balances and account control state.
- [ ] Submit opening count; obtain independent verification before cash work.
- [ ] Check pending work from the previous day and resolve it with the reviewer.
- [ ] Check SMS device/inbox health if used; never count automatic capture as provider settlement.
- [ ] Check applicable approved Forex rates and required real funds before quoting.

### Every day: supervisor/reviewer

- [ ] Verify openings from actual evidence; check funds and each teller's readiness.
- [ ] Review only independent cases within your role/branch; inspect source evidence before posting.
- [ ] Monitor held accounts, quotas, pending collection/payout, exceptions and delivery failures.
- [ ] Use report filters and source/reference history to detect duplicates or unexplained changes.
- [ ] Resolve required pending work before teller close; escalate material variances promptly.

### Every day: operator close and owner sign-off

- [ ] Stop new drawer work and resolve bound pending records/corrections/expenses/manual movements.
- [ ] Count cash physically and record actual wallet/bank/stock evidence at clear UTC times.
- [ ] Submit closing count and explain the variance honestly.
- [ ] Obtain a different reviewer's approval or follow the disputed-count investigation.
- [ ] Investigate held funds; use visible reviewed reconciliation adjustments only where justified.
- [ ] Reconcile unpaid transfer register with the transfer payable and pending payout queue.
- [ ] Save the permitted daily reports/count/voucher evidence by currency and branch.
- [ ] Owner/on-call confirms service workers, backup/alerts and unresolved-case handoff; staff sign out and secure assets.

## 20. Common problems and their resolution

| Symptom | Check first | Resolution |
| --- | --- | --- |
| Plan is empty while creating a tenant | Does a valid published plan exist? | Publish the required plan, or use **Set up plans and continue** for the initial catalogue; reload Create Tenant |
| Create/save button appears ineffective | Required fields, visible error, expired session, existing saved record | Correct the shown error; sign in again if needed; search the original reference before retrying |
| Tenant owner invited but cannot operate | Tenant status, trial/grant term, owner activation/MFA | Platform admin grants the authorized term or resolves status separately; owner finishes activation/MFA |
| Menu/module missing | Active tenant entitlement, user assignment and role | Owner/platform admin corrects the relevant authorized layer; then sign in again |
| Cannot invite/restore staff or create a branch | Reserved seats, pending invites, active branch capacity | Cancel obsolete invites/reassign staff or authorize the correct capacity change |
| Cannot review own opening/transaction | Originator, assigned drawer operator and reviewer identity | Use another eligible person with the correct role/module/branch; do not share an account |
| No opened account in a transaction dropdown | Correct account kind/currency/branch/operator, opening and hold state | Set up the actual account, approve its real opening, resolve holds and configure defaults |
| Branch has accounts but a teller is blocked | Teller's own drawer/default/verified shift | Configure that teller's actual drawer and access; a different teller's account is not a substitute |
| Cash operation blocked | Shift `pending_open`, submitted/disputed state, funds or unresolved work | Obtain proper opening verification or resolve the actual unfinished shift/reviews |
| Wallet balance differs from the phone | Observation time, missing/duplicate events, fee policy, account selection | Record dated real evidence, investigate, then correct/reconcile visibly; do not reset wallet balance |
| Wallet fee policy changed since form opened | Stale form or old account defaults | Refresh the form, recheck summary and original transaction status, then submit the correct event once |
| SMS rejected/unsupported | Device secret/status, sender allowlist, actual profile, timestamp, quota and user entitlement | Correct supported configuration privately; review inbox; use manual entry after duplicate check if needed |
| SMS event is already in the system | Stable message/provider reference and existing source record | Use the original event; do not alter the reference to force a second transaction |
| Banking manual post unavailable | Internal customer account and Customer Accounts access | Use an eligible real internal account with the required module assignment; external masked references alone cannot post |
| Forex quote cannot post | Approved unexpired rate/quote, stock/settlement funds and review | Obtain a valid quote/review and real funded accounts; never change historical rates |
| Transfer cannot issue PIN | Collection manual movement still pending/rejected or not posted | Complete legitimate independent collection review, then use the authorized one-time reveal |
| Transfer payout PIN will not match | Same operating branch, receiver phone, prior use and original transfer; five-minute verification if already checked | Correct/repeat the check or escalate; no cross-branch or duplicate-transfer workaround |
| Transfer payable unavailable to another teller | Clearing account assigned to an individual operator | Owner checks intended shared branch setup and existing evidence; do not reassign staff to evade scope |
| Payout requested but not complete | Payout manual movement pending/rejected, funds/reviewer | Check the original request and obtain independent review before treating it as a completed payout |
| Close day blocked | Pending MoMo, expense/correction or cash-bound manual requests | Complete the source review/reject/void process; do not create another shift |
| Manager cannot approve cash difference | Nonzero variance and reviewer role | Owner or Reconciliation Officer independently decides after investigation |
| Export missing details or fails for range | Source entitlement/assignment, export role, date range/row limit | Use the permitted source, narrower filtered range or appropriate authorized analyst |
| Email is accepted but recipient did not receive it | Provider ID/status, mailbox/spam, opt-in, active recipient | Investigate provider/mailbox separately; do not report accepted as delivered |
| Appointment change did not email requester | Appointment changes are audited state changes | Contact the requester through the approved channel; verify any separate notification action |
| Tenant still suspended after subscription grant | Separate tenant status | Platform administrator completes the authorized status workflow; another grant does not lift suspension |
| A Workspace policy record has no operational effect | Description versus an implemented executable workflow | Use the actual source module controls/exports; historical draft job records are read-only and do not start an import, scheduler or payment engine |
| A quota is exhausted | Current UTC month, plan/grant allocation and actual saved usage | Ask platform admin for an approved capacity/entitlement resolution or wait for the valid new period; retain history |

## 21. Final handover or termination of operations

**Responsible:** Tenant Owner with the Platform Super Admin and the organization's record/data custodian.

1. Stop new business at an agreed UTC cutoff. Resolve legitimate pending collections/payouts, customer liabilities, expenses, corrections, quotes and cash reviews through their proper workflows.
2. Reconcile every physical drawer, provider wallet, bank funds account, Forex stock and transfer payable with dated actual evidence and independent review. Document obligations still outstanding; do not mark them settled merely because the subscription is ending.
3. Produce the permitted final reports/CSV exports by branch and currency, required vouchers, staff/access register and audit evidence. Confirm the recipient and controlled storage before handing over personal data.
4. Confirm platform and all tenant databases are covered by the approved backup/retention process and that encryption/recovery keys remain recoverable by the authorized custodian.
5. Revoke phone devices and disable staff access that is no longer authorized. Cancel unused invitations. Retain any responsible custodian access under an explicit approved arrangement.
6. Platform administrator records the authorized entitlement/status changes with reasons. A suspended or expired tenant is not a deletion or proof that business obligations are discharged.
7. Apply the organization's legal retention and deletion procedure outside ordinary financial posting. Do not delete a tenant database, rewrite journals or remove audit history as a day-close or subscription-cancellation shortcut.
8. Record the final sign-off: cutoff, reconciled positions, unresolved obligations, export/backup custody, access revocations, responsible people and escalation contact.

The completed operation is supported by actual balances, append-only movements, independent decisions and retained evidence. Keep those records connected from onboarding through the last transaction and final handover.
