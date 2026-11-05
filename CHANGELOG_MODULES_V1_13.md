# ClassicFin Hub v1.13 — independent modules and universal Operations Reports

## New workflows

- A published `modular` workspace plan with no bundled operational module, while preserving all existing published plan payloads.
- Individually active, dated and audited Mobile Money and Operations Reports entitlements. Separate monthly-record allocations and independent expiries.
- Tenant Owner module requests, unique pending requests, Super Admin review, audited grant/renewal/revoke actions and request rejection. No payment is fabricated.
- Reports Analyst role and mandatory MFA; assigned report-source visibility grants no transaction/create/review permission.
- A reporting adapter contract, workspace audit-activity report source, and Mobile Money aggregate source. Reporting is available without Mobile Money. A source becomes available only with its own tenant and user access.
- Normalized reporting filters, strict UTC dates, branch scope, cross-tenant data boundaries, bounded grouped results and formula-safe CSV exports.
- Revocation contracts affected active staff and pending invitation assignments and revokes sessions; regrant does not silently restore staff assignments.
- UI updates in existing card styling and without editing `public/css/dashboard.css`.
- Integration script `npm run module:integration` using disposable localhost-only tenant databases and the existing `release:gate` workflow.

## Not claimed

No automatic billing/payment, external Mobile Money settlement, verified live provider callback, or production database certification. The user supplies provider credentials, but code, reconciliation, security and reliability require testing with real services before activation. Existing financial modules other than Mobile Money remain disabled.
