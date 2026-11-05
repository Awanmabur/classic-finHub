# ClassicFin Hub v1.16 — Independently Subscribed Money Transfer Requests

**Release scope:** operational case management, not provider remittances. This module deliberately cannot collect, send, hold, disburse, reverse, or settle funds. No payout PINs are issued. API keys alone do not make financial operations live; licensed-provider onboarding, identity/sanctions screening, settlement state machine, authenticated callbacks, reconciliation and approval evidence remain separate launch requirements.

## Dependency and tenancy design

- MongoDB replica set required for transactional requests and audit writes.
- Tenant-specific `TransferContactV1` and `TransferOrderV1` collections. Data never goes into a shared demonstration store.
- Entitlements are enforced server-side with `money_transfer`; either an active base plan or a separately granted module may entitle the tenant. Assigned staff require their own module grant and fixed-role permission.
- `money_transfer` can run without `reports`; `reports` can run without `money_transfer`. A Reports Analyst can be granted a **report-source** assignment without money-transfer operational permissions.
- `money_transfer_requests` uses a separate UTC-monthly metering counter. Its quota is enforced atomically within the same MongoDB transaction that creates the request and audit event.
- `Tenant Owner` may view and request across active branches. `Money Transfer Operator` is bound to its assigned branch and own records. `Branch Manager` and `Reconciliation Officer` can independently review requests in their own assigned branch. `Auditor` has read-only branch scope. Cross-tenant account access is impossible through the active services because each request uses the server-attached tenant DB connection.
- `Money Transfer Operator` is invitably by Tenant Owners and by Branch Managers only within their own assigned branch/module. Branch Managers cannot grant themselves a module or elevated role.

## End-to-end internal workflow

1. Owner selects an active branch; operator is automatically bound to their assigned branch.
2. Authorized operator registers sender and beneficiary contacts with E.164 phones and two-letter country codes. **These are unverified contact declarations, not KYC approvals.**
3. Operator submits immutable amount, currency, proposed fee, contact snapshots, one-time idempotency key and 1–30-day validity. Only supported branch currency can be used.
4. Quota reservation, branch-state fence, request and audit event commit atomically. Failed operations roll back quota consumption.
5. A different authorized reviewer approves/rejects, with a reason of 12–400 characters. Self-approval, concurrent decisions and expired approvals fail.
6. Pending requests can be cancelled by the originator or Tenant Owner; decided requests cannot be cancelled via this internal method. All changes are audited.
7. A bounded, scheduled expiry job marks overdue pending or approved-for-future-integration requests as `expired` and audits the transition; it is idempotent under concurrent execution.
8. Role-scoped history, immutable details, and printer-friendly **request acknowledgements** are available. No document claims payment or payout.
9. The independent Operations Reports module offers an aggregated Money Transfer reporting source with amounts by currency and internal status. No names or phone numbers are exported through this source.

## Money Transfer state machine

- `requested` → `approved_pending_provider`, `rejected`, `cancelled`, or `expired`.
- `approved_pending_provider` → `expired` while there is **no provider execution integration**.
- Terminal states: `rejected`, `cancelled`, `expired`.

`approved_pending_provider` means *approved for future processing*; it is not payout confirmation. When adding a provider adapter, the execution state machine must introduce atomic dispatch reservations and a separate provider-verified settlement lifecycle **before enabling any payout**. Do not reuse this internal approval as proof of a financial transaction.

## Routes and jobs

- `GET /tenant/money-transfer`, `/history`, `/:id`, `/:id/acknowledgement`.
- `GET /tenant/money-transfer/contacts`, `/contacts/:id/edit`.
- `POST /tenant/money-transfer/contacts`, `/contacts/:id/update`, `/contacts/:id/archive`.
- `POST /tenant/money-transfer/requests`, `/:id/review`, `/:id/cancel`.
- Every action requires a tenant session, active module entitlement, explicit role and permission checks; POSTs also pass global CSRF protection and financial action throttling.
- `npm run transfer:expiry` processes due requests across registered tenant databases. Systemd examples: `deploy/systemd/classicfin-transfer-expiry.{service,timer}`. Install these only after checking absolute paths, private environment file and host service accounts. Monitor exit failures and `possiblyMoreDue` for a growing backlog. No job runs merely because its source file exists.

## Installation and migration

1. Backup the repository and MongoDB, then apply the exact v1.15→v1.16 Git patch or merge carefully.
2. `npm ci` and `npm run check && npm test && npm run perf:assets`.
3. Start the local replica set: `npm run db:dev:up` (Docker Desktop) and run `npm run indexes` to create new unique transfer indexes. Creating indexes is non-destructive but may fail if database permissions or collection contents conflict; resolve errors before writing.
4. The v1.16 new collections are additive; existing Mobile Money and subscription records remain unchanged. New fixed-role access and `money_transfer` runtime availability do not automatically assign it to existing staff. Grant the module as Super Admin and explicitly assign users; no automatic payments are recorded.
5. Run `npm run transfer:integration` against an **isolated local** replica set. It generates scratch tenant databases, exercises quota/approval/cancellation/expiry/reporting and deletes only its generated databases.
6. Run the full `npm run release:gate` (including online npm audit) before staging approval.
7. Enable and monitor the timer only on the intended host, after verifying the logs, credentials, network policies and backup/restore controls.

## Release evidence and exclusions

- Automated unit/source tests: `npm test`; static EJS/JavaScript checks: `npm run check`; asset budgets: `npm run perf:assets`.
- Database-backed integration and npm audit were **not executable in the build environment** (MongoDB refused the connection; npm registry DNS returned `EAI_AGAIN`). Both remain blocking gates.
- Independent security review, live financial-provider onboarding, AML/KYC controls, data retention/privacy safeguards, sanctions controls, provider settlements, chargebacks, payouts, treasury controls, production performance/backup recovery and payment receipts must be verified independently before real funds or financial promises are enabled.
- UI/theme and original dashboard stylesheet are intentionally unchanged. The new HTML uses existing shared components and CSS classes.
