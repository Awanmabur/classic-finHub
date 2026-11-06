# Expenses and operation reports

The approved tenant navigation now has dedicated daily, opening cash, closing cash, transaction, expense, transfer, mobile money, banking and forex report pages. Reports use the tenant database and the signed-in account's permitted sources. A Reports subscription never grants access to an operational source by itself.

## Expense workflow

1. Enable the Expenses module in a published plan or an independent module grant and assign it to the staff account. The tenant owner retains the server-defined owner permissions.
2. `Add expense` records its type, operating-branch currency, amount, vendor, payment method, reference and description. The branch follows the staff assignment; no transaction branch selector is accepted.
3. The record begins as `pending_review`. A Cash request must bind to the originator's independently verified open cash shift. Pending requests do not change cash.
4. A different authorized reviewer approves or rejects the expense. New HTTP requests require an actual funds source before approval: an independently opened cash, bank or mobile-wallet book in the same branch and currency. The source must be active, assigned to the actual operator where relevant, and free of unresolved balance differences. A pending expense may be saved before the source is ready; it cannot spend an invented opening balance.
5. Approval atomically appends a balanced funds-book journal and reduces that source. A Cash posting also updates its bound physical drawer exactly once. Bank and Mobile Money reduce their respective books without changing the drawer or executing a provider payment. The actual provider balance remains a separately dated observation; a mismatch holds the fund for independent reconciliation.
6. Corrections and voids require a request and a different reviewer. Original values, history, batch references and audit events are retained. A correction appends a reversal and a replacement posting; a void appends a reversal. No journal is overwritten. Historical untracked expenses retain their original behavior; they cannot silently change a drawer that has since been bound to a funds book.
7. Closing a shift blocks unresolved expenses and checks the expected closing amount against its funds book. Historical drawers without a funds book retain their immutable-record recomputation. Submitted or reconciled drawers cannot be edited through an expense correction.

Amounts remain separate by currency. Persisted codes are UGX, USD, SSP and KES; the approved interface labels KES as KSH. Each creation reserves its module usage in the same database transaction. Identical retries return the original expense without reserving usage twice.

Authorization is reconstructed from the active tenant and staff records. Mutations fence the persisted tenant, identity, branch and cash shift within their transaction, including concurrent review or module revocation. Operators see their own expenses in their assigned branch; supervisors and auditors retain their defined reporting scope.

## Reports and exports

Opening and closing reports distinguish verified openings, expected cash, submitted physical counts and discrepancies. Pending, rejected and voided expenses remain visible; only approved expense evidence contributes to approved expense totals. Voided Mobile Money records do not contribute recorded fees or cash impact. Recorded fees are not represented as realized income.

Expense detail fields require Expenses view permission. A reporting analyst assigned only aggregate source access receives grouped amounts without vendor, reference or description details. Exports follow the same source permissions, bounded date range and 5,000-row detail limit, with spreadsheet formula neutralization. Print uses the same report data.

These workflows record internal operating evidence and post to the internal ledger. They do not send bank/network payments or claim external settlement. A voucher reviewed by staff is manual evidence, not a live provider API balance.

## Verification

- `node --test tests/expenses-reports.test.js tests/cash-shifts.test.js`
- `NODE_ENV=test node scripts/expenses-reports-integration.js`
- `NODE_ENV=test node scripts/expenses-treasury-integration.js`

The integration test requires one local MongoDB replica set. It creates random scratch platform and tenant databases, exercises concurrent independent decisions and rollback, then removes only those scratch databases. Never run integration checks against production.
