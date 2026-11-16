# Classic FinHub — regional Mobile Money business time and approved rate sheets

Status: **GitHub implementation branch only. Not deployed or production-verified.**

## Regional dates

- Persist transactions, audit events and payout credits as absolute MongoDB `Date` instants. Do not change MongoDB or Docker timezone to mimic a branch.
- Each branch now stores a validated IANA timezone in `timeZone`. Supported examples: `Africa/Kampala` (UTC+03), `Africa/Juba` (UTC+02 since 2021), `Africa/Nairobi` (UTC+03).
- Existing branches without a stored timezone are temporarily resolved from their currency (UGX Kampala, SSP Juba, KES Nairobi; otherwise Kampala). Owners MUST confirm ambiguous legacy USD branches before relying on local business-day reports.
- User-facing Mobile Money transaction history, detail, activity, filter labels and exports show the selected branch's local time. Report `today/week/month/quarter/year` use local midnight converted to UTC query boundaries, including daylight saving transitions where applicable.
- Platform-admin interfaces, every other financial module and historical transaction timestamps displayed elsewhere have **not** yet been globally migrated. Do not declare the entire app localized without a route/view audit.
- When an owner views all branches with multiple timezones, date-windowed Mobile Money summaries must require a single selected branch rather than silently applying the wrong timezone.
- Provider payout `datetime-local` inputs are interpreted according to the verified receiving wallet's branch timezone (not browser locale and not an untrusted submitted timezone). Invalid and ambiguous DST wall times are rejected.

## Approved rate sheets -> financial operations

- Approved tenant/branch/network/operation/currency rate sheets are used for read-only commission and network-charge estimates, both during transaction preview and when persisting an operation.
- Compare effective/expiration dates to the local business day of the operation. Do not choose a sheet approved *after* the actual transaction timestamp.
- Display the snapshot, version, type and currency on saved transaction details, history and CSV exports; do not replace historical versions when a schedule changes.
- An approved sheet may be copied into a draft revision. A separate authorized person approves the replacement; retirement/activation must be atomic, indexed and tested against MongoDB transactions.
- Provider customer network charges, internal customer fees and agent commission estimates are distinct. Never increase physical cash, float, settled income or profits from a network tariff quote.
- Received provider commissions still require independent evidence/settlement, review, and the separate gated accounting path. `ENABLE_MOMO_COMMISSION_POSTING` remains **false**.

## Preproduction verification gate

1. Confirm branch timezone for **every** existing branch, especially USD-denominated branches and cross-border operations.
2. Run `npm test` in a clean GitHub Actions build; include tariff snapshot, tariff management, payout, report and branch administration suites.
3. Test real MongoDB replica-set sessions with two approved schedule versions; verify unique partial indexes support an atomic superseding revision under concurrent reviewers. Rehearse duplicate approval, rollback and retry.
4. Test near-midnight transactions: Kampala (UTC+03), Juba (UTC+02), and a future SMS received before approval. Compare daily CSV, unified reports, cash shift date, and reconciled account statements.
5. Exercise existing branch creation/edit, transaction entry, tariff approval, live quote, transaction save, history, receipts, exports and cross-timezone all-branches reporting on staging.
6. Confirm no financial balances, historical snapshots, provider statement dates, or receipts were rewritten.
7. Deploy via a reviewed image with a tested rollback and production smoke checks, with commission income posting still disabled until independent accounting reconciliation.

**Known remaining work:** The wider platform's other reports, notifications, statements, dashboards, all other transaction modules, exports, and platform admin pages must use the same regional-time contract before full platform-wide compliance can be claimed.
