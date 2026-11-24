# Manual funds and approved tenant UI

The application keeps an expected funds book separately from actual observations. This makes discrepancies visible without inventing a live provider balance or silently changing the book to match an entered number. Manual entry remains available alongside the separately licensed Android SMS capture workflow.

## Establish actual balances

1. Open **Quick setup** as an owner to create money accounts. Use **Business funds** at `/tenant/treasury` to work with existing accounts.
2. Register the real cash drawer, mobile wallet, bank account, foreign-currency stock or transfer payable account for the assigned operating branch and currency. Cash drawers belong to an individual operator. Select an account explicitly when more than one can serve an operation.
3. Record the amount actually in the account, including a genuine zero. Owners can confirm routine openings from the account page. For entries that require approval, record the count, statement or other evidence so a reviewer can confirm it.
4. Financial use requires the subscribed module, staff assignment and action permission. Sensitive reviews require authenticator enrollment. Cash payments require a verified open cash day.

Each funds account has an underlying ledger mapping. Posting checks that its cached book agrees with its immutable movements and ledger, and rejects insufficient funds or an unusable account. The opening is posted once; opening another day's shift does not credit the same funds again. Legacy records are preserved and remain distinguishable from entries connected to the funds book.

## Post manual operations

| Operation | Book effects and evidence |
| --- | --- |
| Mobile money Cash-in | Reduce the selected network wallet and receive the payment in counted cash, bank funds or an eligible customer wallet liability. |
| Mobile money Cash-out | Increase the selected network wallet and release the payment from counted cash, bank funds or an eligible customer wallet liability. |
| Banking deposit / withdrawal | After separate manual movement review, credit/debit the real internal customer account against the selected funded account. A masked external bank reference alone cannot receive an internal account posting. |
| Banking account transfer | After review, debit and credit the selected internal customer liabilities together; an unfunded customer debit is rejected. |
| Forex buy / sell | Use the source quotation's locked approved rate. Independent movement review posts the foreign stock and settlement funds in their separate currencies, with an explicit fee counterparty. |
| Money transfer collection | Independent review posts collected funds and the transfer payable, then makes a private payout PIN available for one-time reveal. |
| Money transfer payout | Check the PIN and receiver details, select the actual payout account, then obtain separate review before funds and the payable decrease. This is a manual payout, not a provider settlement acknowledgement. |
| Expense | Independent review debits the selected funded cash, bank or mobile wallet. Corrections and voids preserve the original and post linked reversals/replacements. |

For banking, forex and transfers, source instructions and quotations remain nonfinancial until their manual movement is approved. Use the source detail page's manual movement action; posted records link to their execution and journal evidence. The manual review queue is `/tenant/funded`. Duplicate retries are matched to their original economics and do not post twice. Self-review and changed or revoked access cannot approve a new posting.

Daily mobile money entry uses the wallet already configured for the operating branch and operator. An eligible default is selected automatically; another wallet can be selected when needed. The cash or bank payment account is resolved from its configured default. Balance setup, observations, funding and fee policy stay on the Wallets page, rather than appearing on every transaction. A customer account is selected only for Wallet Balance payments.

Wallet settings define how fees affect future entries: record only, fee actually collected from the customer, or commission actually credited to the wallet. The transaction preview and posting use that policy. Daily HTTP entries cannot override it, and an open form is rejected if the wallet policy changes before posting. The book never assumes that an informational commission reached cash or the network wallet. An optional agent balance from a supported SMS remains dated evidence and can hold a mismatched wallet for review.

## Add funds and configure wallets

From **Business funds**, find the account that received the money and choose **Add money**. Owners can record money they already put into the business with **Add new business money** and **Save now**. Staff with the necessary access choose **Record an owner contribution**, enter the amount and receipt or statement reference, then send it for independent approval.

Use **Transfer existing funds** when the money came from another tracked business account. The transfer posts to both accounts in the same branch and currency. An owner contribution credits owner equity. Cash funding updates the verified open drawer. Money can stay in the account across days without creating a customer transaction. The account activity shows the funding and journal.

Choose **Edit details** to correct an account name or change its defaults for future entries. Name corrections are audited and keep the same funds account and ledger.

Tenant owners can set up an account in the branch selected for administration. All-branches view requires choosing a specific branch before creating an account. Funding derives its branch from the selected accounts. Daily customer transactions continue to use the operator account’s assigned operating branch.

## Compare actual and expected

Choose **Check balance** on the account and enter the amount you counted or saw on the statement. Routine checks entered by the owner are recorded immediately. Entries that require a separate decision appear in **Review balances and funding**. The account shows the recorded balance, the last confirmed actual amount and any difference.

A reported discrepancy holds the account for investigation. A later entry can also make an earlier observation stale. Once the difference has been reviewed and confirmed, use **Correct balance** on the account to explain and submit the adjustment. After independent approval, the adjustment appears in **Activity** alongside the original records.

## Open and close the cash day

Open **Cash day**, select the currency, and confirm or enter the opening cash count. When work is finished, return to **Cash day**, check the expected cash and enter the amount you counted. Resolve pending cash movements before closing. The same page shows the day’s status, review actions when needed and prior days. Closing cash stays in the drawer's funds account for the next opening.

The supported explicit SMS profile may append `; Agent Balance: UGX 500,000` (or KES matching the transaction currency). Only that labelled agent amount is treated as wallet evidence; generic/customer balances, ambiguous messages and changed provider wording remain for review. The observed time follows the SMS source time. SMS capture is not a direct provider balance API and requires a configured, authorized Android gateway and supported message profile.

## UI and reports

`index.html` remains the approved design reference. The generated tenant stylesheet retains its complete ordered style blocks, including the final navy colors; the overview and operation sheets use its labels and component structure. Wallet setup and evidence use the same form components on the Wallets page. Focused inputs have one approved outer control border/ring. The desktop sidebar, independent navigation scroll, modal service tabs, headers and footers retain the approved scrolling behavior. Native settings dialogs and operation sheets retain their separate approved geometries.

Date, network, currency, source, status and other existing report/activity filters remain available where supplied by each page. Posted physical cash totals come from immutable Treasury movements by actual event date, including collected cash fees and reversals. Historical MoMo records without book postings remain in a separate evidence subtotal, so they cannot be counted twice. CSV exports preserve that distinction. The display currency control does not combine unlike currencies. Tenant owners and auditors default to the main branch and can choose another active branch or All branches for viewing. That selection persists across reports and filters. A separate operating-branch indicator identifies where a daily transaction will be recorded; the transaction branch is derived by the server, with no branch picker inside the form. After a successful create, the view follows the branch where the record was saved. Operational navigation, report-source links, receipt actions and cash cards follow active subscriptions and staff permissions. MoMo and other daily currency controls offer the assigned branch's enabled operating currencies. Each currency uses its own accounts, verified drawer and ledger totals. The default only supplies the initial selection; an unsupported or disabled currency and a mismatched wallet or payment account are rejected by backend validation.

## Updating an existing installation

Run `npm run indexes` using the installation's configured database before starting the updated application. New tenant provisioning creates the required Treasury and funded-operation indexes automatically. Existing historical records retain their untracked state; register and independently review actual opening evidence before processing new manual operations.

## Verification

The release gate includes unit checks and disposable real-Mongo integration scripts for Treasury, MoMo funds, manual banking/forex/transfers and funded expenses. Browser verification covers the rendered financial forms, independent review, actual journal/balance changes and approved component appearance at desktop/mobile widths. Use the recorded check results for the current revision; component similarity does not imply that every populated page is pixel-identical to a static prototype.

The 6 November baseline sequential release gate passed 369 JavaScript tests, 13 Android relay tests, all registered disposable database integrations and 598 JS/EJS syntax/template checks. The dependency audit found zero vulnerabilities. Fresh Chromium checks passed 16 reporting filter round trips and 42 modal captures, with no JavaScript or asset errors. [Recorded evidence](review/manual-funds/README.md) includes the approved-theme overview and actual wallet discrepancy details.

The 7 November follow-up passed the full release gate with 377 JavaScript tests, 13 Android relay tests, wallet funding and branch-view HTTP/Mongo integrations, and zero dependency vulnerabilities. Direct browser comparisons checked sticky behavior and input structure at 1440/390/320px, actual wallet setup/funding and daily default posting, and 16 report filter submissions preserving the branch view. [Current interaction and workflow evidence](review/wallet-branch-behavior/README.md) supersedes the earlier repeated-balance-entry form.
