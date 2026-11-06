# Approved tenant UI implementation

Reference: the user-approved `index.html`, including the later scripts that append navigation and replace modals. The final navigation has eight groups and seventy submenu entries. The original file remains unchanged as the design reference.

## Pages and data

| Approved group | Entries | Database connection |
| --- | ---: | --- |
| Overview | 3 | Current authorized module activity, cash shifts, latest operation acknowledgement |
| Money Transfer | 6 | Transfer instructions, immutable contact snapshots, independent review, pending provider queue, proposed fees and filtered reports |
| Mobile Money | 5 | Cash-in, Cash-out, Network activity, Cash impact and Mobile money report, all using tenant transaction records |
| Forex Operations | 6 | Buy/sell quotation direction, approved rate snapshots, quotation records, pending execution, separate currency totals and reports |
| Banking Operations | 11 | Customer directory/logbook, customer accounts, posted-ledger balances/movements, deposit/withdrawal/transfer instructions and reports |
| Operation Reports | 14 | Daily, opening, closing, transactions, expenses and individual operational sources; CSV and print; open/close controls |
| Tenant Workspace | 17 | Profile, landing content and published snapshot, branding/receipt identity, existing branches/staff, fixed permissions, settings definitions, database statistics, subscription terms, previews and audit |
| Phase 2 Control | 8 | Existing notifications, owner analytics, staff, audit, approvals, cash reconciliation and settings |

Menus require the subscription, staff module assignment and fixed role permission. A fully entitled owner has all seventy entries; an unassigned or read-only user receives the corresponding restricted navigation. Duplicate links select one sidebar entry. Legacy detail/history routes retain their module group selection.

## Mobile Money

The entry form uses the approved operation/network/customer/reference/amount/fee/payment labels, sections and submit wording. Phone is required in manual UI; customer name is optional and falls back to the supplied phone. Manual records preserve the customer phone/note and declared payment method. Manual entry remains available alongside subscribed Android SMS capture.

All five pages have scoped date, network, currency and entry-source filters. Pagination uses indexed cursors. Network summaries group by network **and currency**. Internal voids remain visible in history and are excluded from active totals. Physical cash reports include Cash-method entries only; Bank and Wallet Balance entries are instructions and do not alter a physical drawer. Fees/commission are recorded separately and are not treated as collected drawer cash or verified profit.

Cash entries require an independently approved opening count. Closing recomputes immutable transaction movements and approved cash expenses. Different authorized staff review opening, correction, expense and closing decisions. The operating branch follows the authenticated account; transaction forms have no branch picker.

UGX, USD, SSP and ISO KES are supported by the core currency foundation. Kenyan shillings appear as KSH in approved selectors/context. Amounts are stored and aggregated in exact minor units. Existing SMS confirmation profiles remain limited to their verified UGX/KES formats; unrecognized messages stay in review.

## Forms, settings and security

- Shared operation sheets load the actual permission-checked server form and retain its CSRF token and idempotency key. Field values are validated again by the service. Native settings/customer/expense dialogs also have real form fallbacks.
- Transfer identity-document references, declared method/purpose/rate; banking payment channel/contact/external reference; and forex phone/document/proposed commission/settlement method/rate source/external reference are immutable instruction snapshots and participate in idempotency checks.
- New customer accounts can be selected on banking instructions alongside masked bank references. The bridge checks active customer/account, branch, currency, ledger mapping and current module access; it snapshots masked identity and does not post funds.
- Subscription and account changes are fenced in financial/database transactions. Revocation, disabled users, changed roles/branches and reduced quotas cannot race a successful new financial record.
- Workspace settings have fresh owner authorization, revision checks and transactional audit. Published landing snapshots are separate from drafts. Saved branding applies to tenant theme and actual operation acknowledgements without changing immutable historical references.
- KYC/compliance/integration/notification definitions are saved configuration metadata. Existing notifications and signed SMS use their implemented services. Descriptions do not create live provider adapters or claim automated identity/watchlist enforcement.
- Static assets bypass page budgets. Signed server-side session identities have separate bounded page budgets, so branch staff sharing an IP do not exhaust one another's navigation allocation. Public/login and financial action limits remain enforced.

## Remaining execution boundaries

The approved prototype simulates some successful financial actions in browser storage. Production code does not copy those success states:

- Provider remittance/PIN issuance and payout, bank execution and FX trade settlement still require verified adapters/evidence. Their workspace pages show the genuine pending instructions/quotes and state the capability boundary.
- Customer accounts start with zero posted balance. Opening deposits and overdraft facilities require authorized accounting workflows; entered directory metadata cannot mint funds. Balances/movements reflect actual ledger postings.
- KYC verification, automated compliance enforcement, custom permission-role authoring, tenant-safe backup/restore/import runners and customer self-service are not supplied by descriptive workspace settings. Subscription terms and routing/domain allocation remain platform-controlled.

These are remaining implementation/integration items, not completed simulated operations. See [Customers and accounts](../CUSTOMERS_AND_ACCOUNTS.md), [Expenses and reports](EXPENSES_AND_REPORTS.md), [Workspace configuration](TENANT_WORKSPACE_CONFIGURATION.md) and the existing SMS/plan guide for the individual workflows.

## Validation

`npm run release:gate` includes the unit suite and real MongoDB integration checks for Mobile Money workspaces, customer/accounts, expenses/reports, workspace settings, currency handling, authorization races and the existing financial modules. Integration scripts restrict themselves to disposable local databases.

Browser verification uses a disposable full-entitlement tenant and separate MFA accounts. It checks all seventy links, actual operation/customer/account/expense writes, workspace publication and independent cash reconciliation, plus 1440px/390px/320px layouts. Selected sanitized evidence is kept in `docs/review/approved-ui/`.
