# Expenses and operation reports

The approved tenant navigation now has dedicated daily, opening cash, closing cash, transaction, expense, transfer, mobile money, banking and forex report pages. Reports use the tenant database and the signed-in account's permitted sources. A Reports subscription never grants access to an operational source by itself.

## Expense workflow

1. Enable the Expenses module in a published plan or an independent module grant and assign it to the staff account. The tenant owner retains the server-defined owner permissions.
2. `Add expense` records its type, operating-branch currency, amount, vendor, payment method, reference and description. The branch follows the staff assignment; no transaction branch selector is accepted.
3. The record begins as `pending_review`. A Cash request must bind to the originator's independently verified open cash shift. Pending requests do not change cash.
4. A different authorized reviewer approves or rejects the expense. Approval atomically reduces the linked physical cash estimate. Bank and Mobile Money record reviewed evidence without executing an external payment or changing physical cash.
5. Corrections and voids require a request and a different reviewer. Original values, history and audit events are retained. Approved Cash corrections adjust the drawer by the exact difference; approved voids reverse the internal cash effect.
6. Closing a shift blocks unresolved expenses and recomputes the expected movement from Mobile Money Cash entries and approved Cash expenses. Submitted or reconciled drawers cannot be edited through an expense correction.

Amounts remain separate by currency. Persisted codes are UGX, USD, SSP and KES; the approved interface labels KES as KSH. Each creation reserves its module usage in the same database transaction. Identical retries return the original expense without reserving usage twice.

Authorization is reconstructed from the active tenant and staff records. Mutations fence the persisted tenant, identity, branch and cash shift within their transaction, including concurrent review or module revocation. Operators see their own expenses in their assigned branch; supervisors and auditors retain their defined reporting scope.

## Reports and exports

Opening and closing reports distinguish verified openings, expected cash, submitted physical counts and discrepancies. Pending, rejected and voided expenses remain visible; only approved expense evidence contributes to approved expense totals. Voided Mobile Money records do not contribute recorded fees or cash impact. Recorded fees are not represented as realized income.

Expense detail fields require Expenses view permission. A reporting analyst assigned only aggregate source access receives grouped amounts without vendor, reference or description details. Exports follow the same source permissions, bounded date range and 5,000-row detail limit, with spreadsheet formula neutralization. Print uses the same report data.

These workflows record internal operating evidence. They do not send bank/network payments, post external settlement, or bypass the separate financial ledger and verified-provider-evidence requirements.

## Verification

- `node --test tests/expenses-reports.test.js tests/cash-shifts.test.js`
- `NODE_ENV=test node scripts/expenses-reports-integration.js`

The integration test requires one local MongoDB replica set. It creates random scratch platform and tenant databases, exercises concurrent independent decisions and rollback, then removes only those scratch databases. Never run integration checks against production.
