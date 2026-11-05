# ClassicFin Hub v1.14 — Mobile Money Operations and Reporting

## Architectural boundary

Keep Mobile Money and Operations Reports as independently subscribed modules. Every Mobile Money route requires its own active entitlement and a backend permission. Operations Reports has a separate entitlement, checks every optional data source independently and never grants transaction permission through reporting access.

The operational record store is **not** the immutable general ledger and does not prove an external provider transfer. The v1.11–v1.12 financial core has its own protected evidence and reconciliation lifecycle. This v1.14 work does not automatically bridge an unverified manual record into that financial core.

## Working business flows

1. An authorized Mobile Money Operator (or Tenant Owner) records a cash-in/cash-out with a network reference, branch, exact amount, fee, currency, customer name and form idempotency key. It consumes the independent module quota once, within a MongoDB transaction, and remains `pending_verification`.
2. An independent Tenant Owner or Reconciliation Officer reviews the operation. They cannot approve their own entry. This is an **internal** acceptance or dispute, not provider confirmation.
3. The originating operator can request a void of a mistaken **unverified** record with a 12–400 character justification; the original economic fields cannot be changed. A correction case is stored on the record, with a separate tenant audit event in the same database transaction.
4. A separate authorized reviewer approves or denies the correction. An approved request sets `correctionState=voided` and `status=voided_internal`; it cannot generate a ledger posting, transfer, refund or external reversal. Denial is recorded and permits a revised request. At most five requests can be made for a single record.
5. While a correction is pending, the ordinary review queue omits that record. Conditional database updates block stale, duplicate and concurrent decisions.
6. All prior correction requests and decisions remain on the record as chronological history, with associated audited actions. The original network reference remains reserved against duplicates.
7. The operator may browse `/tenant/mobile-money/history` using a 90-day maximum window and stable cursor pagination; entries remain within their own assigned branch and, for operators, their own record ownership. Read-only viewers cannot access investigator notes.
8. Operations Reports aggregates module activity by network, operation, operational state, review state and correction state, but only when the tenant and user have both Reports and Mobile Money source entitlements. A standalone Reports-only account continues to see workspace activity without buying Mobile Money.

## Route matrix

| Route | Required guard | Effect |
|---|---|---|
| GET `/tenant/mobile-money` | Mobile Money + `mobile_money.view` | Role-aware record, review and correction queues |
| POST `/tenant/mobile-money/cash-in`, `/cash-out` | Module + cash permission + abuse throttle + CSRF | Unverified operational record |
| POST `/tenant/mobile-money/:id/review` | Module + review permission + throttle + CSRF | Independent internal review |
| POST `/tenant/mobile-money/:id/request-void` | Module + view permission + throttle + CSRF + service owner check | Originator correction request |
| POST `/tenant/mobile-money/:id/decide-void` | Module + review permission + throttle + CSRF + service second-person/branch check | Independent approval/denial |
| GET `/tenant/mobile-money/history` | Module + view permission | Paginated scoped history |
| GET `/tenant/mobile-money/:id` | Module + view permission | Scoped record evidence; notes redacted for viewers |
| GET `/tenant/reports` | Separate Reports + `reports.view` | Independent reporting hub |
| GET `/tenant/reports/export.csv` | Separate Reports + `reports.export` | Spreadsheet-safe aggregate export |

No generic payment posting, voiding or ledger-writing endpoint was exposed.

## Data and upgrades

`SecureMobileTransaction` gains `correctionState`, `correctionAttempts`, the current correction metadata and an array of timestamped correction history events. The schema and its supporting history indexes are additive; older records without fields are safely treated as having no corrections. Run `npm run indexes` against a secured replica set as part of staging. **Never edit financial history with a direct database migration.**

The original stylesheet `public/css/dashboard.css` is unchanged; the new forms and history screens reuse its existing card, field, table and button classes. Existing sessions, module prices and subscription snapshots are unchanged.

## Verification and operational gates

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run perf:smoke
npm run db:dev:up
npm run indexes
npm run mobile-money:integration
npm run module:integration
npm run release:gate
```

`mobile-money:integration` exercises a real MongoDB replica set with two temporary tenants, real recording, retry and idempotency, independent review, correction denial/re-request/approval, history, audit atomicity and cross-tenant isolation. It is restricted to loopback development and refuses production. Do not run destructive integration scripts against operational databases.

Production launch still requires independently verified database migration, real MongoDB transaction tests, npm vulnerability audit clearance, provider-specific callback authentication, sandbox statement matching, reconciliation, failure injection, live edge security, backup-restoration and rollback drills. If an API is unconfigured, the external payment operation stays disabled. Credentials alone do not establish payment correctness.
