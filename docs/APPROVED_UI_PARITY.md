# Approved tenant UI implementation

Reference: the user-approved `index.html`, including the later scripts that append navigation and replace modals. The final navigation has eight groups and seventy submenu entries. The original file remains unchanged as the design reference.

## Pages and data

| Approved group | Entries | Database connection |
| --- | ---: | --- |
| Overview | 3 | Current authorized module activity, cash shifts, latest operation acknowledgement |
| Money Transfer | 6 | Transfer instructions, immutable contacts, reviewed manual collection, private payout PIN, reviewed payout and filtered reports |
| Mobile Money | 5 | Cash-in, Cash-out, Network activity, Cash impact and Mobile money report, all using tenant transaction records |
| Forex Operations | 6 | Buy/sell quotations, approved rate snapshots, reviewed manual stock/settlement movements, separate currency totals and reports |
| Banking Operations | 11 | Customer directory/logbook, customer accounts, posted-ledger balances/movements, deposit/withdrawal/transfer instructions, reviewed manual posting and reports |
| Operation Reports | 14 | Daily, opening, closing, transactions, expenses and individual operational sources; CSV and print; open/close controls |
| Tenant Workspace | 17 | Profile, landing content and published snapshot, branding/receipt identity, existing branches/staff, fixed permissions, settings definitions, database statistics, subscription terms, previews and audit |
| Phase 2 Control | 8 | Existing notifications, owner analytics, staff, audit, approvals, cash reconciliation and settings |

Menus require the subscription, staff module assignment and fixed role permission. A fully entitled owner has all seventy entries; an unassigned or read-only user receives the corresponding restricted navigation. Duplicate links select one sidebar entry. Legacy detail/history routes retain their module group selection.

## Mobile Money

The entry form uses the approved operation/network/customer/reference/amount/fee/payment labels, sections and submit wording. Phone is required in manual UI; customer name is optional and falls back to the supplied phone. Manual records preserve the customer phone/note and declared payment method. Manual entry remains available alongside subscribed Android SMS capture.

All five pages have scoped date, network, currency and entry-source filters. Pagination uses indexed cursors. Network summaries group by network **and currency**. Internal voids remain visible in history and are excluded from active totals. Physical cash reports include actual Cash-method movements only. Bank and customer Wallet Balance payments update their selected funded account or customer liability when posted; they do not alter a physical drawer. Explicitly collected fees and credited commissions are distinguished from informational fees. Existing legacy records without a funded book remain identifiable as untracked.

Cash entries require an independently approved opening count. Book-managed drawers close against immutable fund movements, including approved cash expenses and other manually posted operations. Legacy drawers retain their original record recomputation. Different authorized staff review opening, correction, expense and closing decisions. The operating branch follows the authenticated account; transaction forms have no branch picker.

UGX, USD, SSP and ISO KES are supported by the core currency foundation. Kenyan shillings appear as KSH in approved selectors/context. Amounts are stored and aggregated in exact minor units. Existing SMS confirmation profiles remain limited to their verified UGX/KES formats; unrecognized messages stay in review.

## Forms, settings and security

- Shared operation sheets load the actual permission-checked server form and retain its CSRF token and idempotency key. Field values are validated again by the service. Native settings/customer/expense dialogs also have real form fallbacks.
- Transfer identity-document references, declared method/purpose/rate; banking payment channel/contact/external reference; and forex phone/document/proposed commission/settlement method/rate source/external reference are immutable instruction snapshots and participate in idempotency checks.
- New customer accounts can be selected on banking instructions alongside masked bank references. The bridge checks active customer/account, branch, currency, ledger mapping and current module access. An instruction alone does not post funds; the separate independently reviewed manual movement posts the customer liability and selected funded account together.
- Subscription and account changes are fenced in financial/database transactions. Revocation, disabled users, changed roles/branches and reduced quotas cannot race a successful new financial record.
- Workspace settings have fresh owner authorization, revision checks and transactional audit. Published landing snapshots are separate from drafts. Saved branding applies to tenant theme and actual operation acknowledgements without changing immutable historical references.
- KYC/compliance/integration/notification definitions are saved configuration metadata. Existing notifications and signed SMS use their implemented services. Descriptions do not create live provider adapters or claim automated identity/watchlist enforcement.
- Static assets bypass page budgets. Signed server-side session identities have separate bounded page budgets, so branch staff sharing an IP do not exhaust one another's navigation allocation. Public/login and financial action limits remain enforced.

## Manual funds and execution boundaries

Manual funds now have a separate durable book backed by reviewed opening evidence, immutable movements and balanced journals. See [Manual funds and UI](MANUAL_FUNDS_AND_UI.md) for setup and operating instructions. The approved prototype's local browser success state is not used as financial evidence:

- Reviewed manual banking, FX and transfer collection/payout can post actual book movements. A private once-revealed transfer PIN identifies a manually collected transfer; receiver verification and independent review precede payout. These states are labelled manual and do not assert external provider execution. Live bank/mobile-wallet balance APIs and provider settlement adapters remain separate integrations.
- Customer accounts start with zero posted balance. A funded, independently reviewed manual banking deposit can credit an account; entered directory metadata cannot mint funds. Balances/movements reflect actual ledger postings. Overdraft metadata does not permit an unfunded debit.
- KYC verification, automated compliance enforcement, custom permission-role authoring, tenant-safe backup/restore/import runners and customer self-service are not supplied by descriptive workspace settings. Subscription terms and routing/domain allocation remain platform-controlled.

Provider adapters and the remaining configuration-driven capabilities are still separate work. See [Customers and accounts](../CUSTOMERS_AND_ACCOUNTS.md), [Expenses and reports](EXPENSES_AND_REPORTS.md), [Workspace configuration](TENANT_WORKSPACE_CONFIGURATION.md) and the existing SMS/plan guide for the individual workflows.

## Design source and validation

The tenant stylesheet retains all approved `index.html` style blocks in their original order, including the final navy palette. The overview uses the approved volume cards and operation sheets retain the approved sections, wording and layout. Real balance and review controls extend the prototype where financial evidence is needed. Reporting and activity filters remain available. Component checks are not a claim that every populated screen is pixel-identical.

`npm run release:gate` includes the unit suite and real MongoDB integration checks for Mobile Money workspaces, customer/accounts, expenses/reports, workspace settings, currency handling, authorization races and the existing financial modules. Integration scripts restrict themselves to disposable local databases.

Browser verification uses a disposable full-entitlement tenant and separate MFA accounts. It checks all seventy links, actual operation/customer/account/expense writes, workspace publication and independent cash reconciliation, plus 1440px/390px/320px layouts. Selected sanitized evidence is kept in `docs/review/approved-ui/`.
