# Customers and customer accounts

Customers & KYC and Customer Accounts are separate assignable modules. Their
registry reference prices are USD 39/month and USD 59/month; the platform
administrator controls published plan prices, capacity and module grants.
Publishing these features does not silently change existing immutable subscription
snapshots. Enable the modules through a new published plan or an audited platform
grant with a nonzero record allowance before creating records.

The approved Banking Operations navigation now has database-backed customer and
account directories, customer creation, customer logbook, account creation,
account balances and account movements. Transaction branch selection follows the
signed-in account's operating branch. A customer account uses that branch's
currency (UGX, USD, SSP or canonical KES, displayed as KSH).

Customer forms include identity and contact details, customer type/reference,
next of kin, country, city and address/notes. Customer references stay fixed.
Account forms include the customer owner, account number/type/status, officer,
purpose/source of funds and risk metadata. Account owner, number, branch and
currency stay fixed. Directory metadata is not evidence of completed KYC.

Each new account has a separate zero-posting liability ledger mapping. Balances
and movements come only from existing append-only ledger postings in the same
branch/currency. Opening amounts and overdraft values must be zero; creating or
editing a directory record does not deposit funds or approve credit. Banking
requests remain separate from posted account movements.

Creation uses a server-issued idempotency key. Mismatched replays are rejected.
Duplicate account numbers/references roll back new mappings, usage and audit
writes together. Mutations lock and recheck the current tenant entitlement,
active staff account and assigned branch inside the business transaction.
Optimistic revisions reject stale edits. Profiles with unclosed accounts cannot
be archived, and nonzero book balances prevent closing an account directory
record. Directory status does not change the accounting system's posting rules.

The logbook shows exact recorded phone matches from separately entitled Mobile
Money and Money Transfer sources plus linked customer-account ledger postings.
A phone match is an activity reference, not proof of identity or settlement.
Module assignments and tenant/branch scopes still apply to every source.

`GET /tenant/customers/export.csv` requires the Customers module and
`customers.export`. Its audited export includes reference, name, phone, email,
type, country, city, status and creation time. Identity numbers, next-of-kin
contacts and internal notes are excluded. CSV cells neutralize spreadsheet
formulas; exports use a bounded cursor with a 10,000-record cap.

Run `node tests/customer-accounts.test.js` for validation/view contracts and
`node scripts/customer-accounts-integration.js` for isolated loopback-replica
checks. The integration script creates random scratch platform/tenant databases
and drops only those databases after checking real writes, rollback, quotas,
audit, scopes, live revocation, exact balances, linked activity and safe exports.
