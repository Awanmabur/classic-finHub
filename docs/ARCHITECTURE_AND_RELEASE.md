> **Historical architecture audit:** some items below were implemented or changed in v1.3. Refer to [the current v1.3 release guide](SECURITY_PERFORMANCE_SEO_RELEASE_V1_3.md) for verified status.

# ClassicFin Hub — Architecture, Security and Release Gates

**Revised:** 2026-11-03 (Windows recovery and authentication fixes)
**Implementation:** initial hardened release candidate, **not production-certified**.

## 1. Design principles

1. Keep the existing EJS dashboard UI and visual system. Do not replace the project with a different framework.
2. Never infer tenant or operator authority from request headers, query strings or posted form fields.
3. Deny financial actions when authorisation, persistence, reconciliation or provider evidence is unavailable. `501` deliberately replaces legacy mock workflows.
4. Keep plan entitlement, module implementation status, and user permission separate. A module being sold **does not** make its financial action operational.
5. Never describe an unverified operational record as a settled payment.
6. Financial records are immutable after creation except via explicit authorised, auditable transitions, which are **not yet implemented**.

## 2. Request and data architecture

```
Client -> HTTPS/Caddy -> Express (Helmet, rate limit, CSRF, session)
                         |-- public routes (SEO, enquiries)
                         |-- platform auth -> Platform DB (admins, tenants, invitations)
                         |-- tenant auth -> tenant ID from session -> platform Tenant record
                                -> tenant DB via cached mongoose.useDb()
                                -> role policy + subscription + module runtime gate
                                -> immutable Mobile Money record + audit in Mongo transaction
                                -> summary/report/export (database-filtered, time bounded)
```

MongoDB holds both platform metadata and per-tenant logical databases. A shared bounded client pool prevents a new socket pool for every tenant. A unique, validated slug forms the tenant DB name; it is resolved only after a platform DB lookup. The Mongo user still has broad permissions across tenant DBs: this is **logical isolation**, not separate cluster or credential isolation. For regulated/enterprise clients, consider per-tenant credentials, separate clusters and storage encryption policies.

Authenticated user roles are derived from a **server-maintained permission registry**, not permissions supplied by the browser. Platform administrators can create a tenant. Tenant owners can invite Mobile Money Operators, Auditors and Viewers. Branch Manager assignment is intentionally disabled until branch-scoped query enforcement and staff-to-branch assignment exist. Operators can only read their own recorded Mobile Money operations; auditors and tenant owners can see tenant-wide records.

## 3. Identity and account lifecycle

- Platform first admin is provisioned explicitly with `npm run bootstrap`; there is **no seeded password**.
- bcrypt password hashing, minimum 14-character account activation policy; login IP throttling, generic invalid-credential responses.
- Session ID regenerated after login; session stored in Mongo with expiration; session cookies are HTTP-only, SameSite=Lax, Secure when production, eight-hour lifetime. Disable staff and the next request fails.
- CSRF token is bound to the session for state-changing form requests; invitation tokens are random, SHA-256-hashed in Mongo, one-time and short-lived.
- Public signups create onboarding requests **not** authenticated accounts. Password reset UI routes are disabled until audited recovery, email verification and account recovery handling exist.
- Missing tenant, inactive account, suspended tenant, expired trial and invalid module entitlement are rejected. Billing remains available where appropriate.

## 4. Plans and module contracts

The existing product catalogue in `src/data/store.js` is the authoritative **proposed** pricing source for public pricing and platform plan views. Prices should be confirmed commercially and versioned before billing goes live. Plan codes: `starter_trial`, `agent`, `finance`, `enterprise`. Module entitlements are computed server-side as **plan inclusion AND tenant enablement AND runtime capability**.

Only `mobile_money` is `recording_only`. All transfer, banking, forex, notification and financial settlement flows are disabled (not fake success). Existing catalogue information and UI remain available as reference only. User-seat limits are reserved atomically using MongoDB transactions; expired unused invitations release seats on the next invitation request. Automated expiry cleanup, full plan migration and subscriptions require background jobs later.

**Pricing warning:** public/plan figures are indicative and no payment processor has been connected. Do not treat trial, payment, marketplace or invoicing copy as an active contract or an actual payment.

## 5. Mobile money recording

- Operation types: `cash_in`, `cash_out`. Allowed networks MTN, Airtel, M-Pesa; currency codes UGX and KES. Support for country-specific network rules remains to be implemented.
- Customer, unique network reference, positive bounded amount, fee, operator ID, idempotency key and timestamp validated before persistence.
- Amounts recorded as exact integer minor units in Mongo Decimal128; summaries computed in Decimal128 and formatted using `BigInt` (no cross-currency totals).
- Per-tenant unique indexes on request idempotency and network reference. Transaction and audit event committed atomically in Mongo replica-set transactions.
- Transaction status `pending_verification`: **no money movement, no float balance mutation, no network settlement, no bank balance, no automatic receipt**.
- Duplicate exact retry returns the original record; different payload under the same key is rejected. Index creation is guaranteed before writes.
- Operators see their own records; tenant owners and auditors see tenant-wide records. Reports filter UTC dates (max 90-day span), are grouped by network/operation/currency/status and export at most 5,000 rows; over-limit exports are rejected, never silently truncated.
- CSV is escaped against spreadsheet formula injection.

**Not implemented:** provider callback signature verification, provider status lookup, reversal, suspicious-activity checks, matching network settlements to local records, cash drawer updates, provider outage retries, true double-entry ledger, float/balance control, chargeback or dispute workflow. Do not settle customer funds using this release.

## 6. Security controls and remaining gaps

**Added:** tenant/user authorization, default deny, no header-based tenant selection, CSRF, login throttling, private activation, neutral error responses, fixed role permissions, atomic writes, no demo data in tenant dashboards, production secret validation, session storage, noindex for private routes, security headers and basic tests.

**Still requires work:** strict nonce-based CSP (existing inline UI assets currently require `'unsafe-inline'`), distributed throttling, MFA, password recovery and verification, session device management, secret rotation, immutable off-host audit log storage, anti-abuse and bot protection, WAF, SAST/DAST/SCA, penetration testing, load/soak tests, encrypted PITR backups with restore drills, incident response, external provider failure testing, payment compliance, KYC/AML, data retention and deletion, tenant database lifecycle, privacy/legal policies and operational observability. These are **release blockers** for real funds.

## 7. Operational release sequence

1. Isolate this branch/release from the current deployed application, and back up MongoDB and the current app before any upgrade.
2. Install dependencies from the committed lockfile (`npm ci`) using supported Node.js LTS.
3. Provision a MongoDB replica set; restrict network and DB credentials; configure the session secret and HTTPS origin. Use Caddy with trusted proxy configuration appropriate to the deployment.
4. Run `npm run indexes`, `npm run check` and `npm test` in CI. Bootstrap admin securely once; create an isolated test tenant and verify owner and staff invite flows.
5. Perform **live Mongo integration tests** (transactions, index uniqueness under concurrency, tenant leakage attempts, session revocation, seat-limit races). This could not be run in the offline editing environment.
6. Run provider sandbox tests and reconcile amounts, fees, timestamps, callbacks and reversals. Keep real-money operations disabled until approved.
7. Execute dependency audit, SAST, DAST, external penetration test, load test, backup restore, PITR drill, rollback and alerting/monitoring validation.
8. Review business licences and financial regulations in each operating country before accepting or transferring funds.
9. Roll out to a private pilot first, then a gated production release with feature flags and incident-response ownership.

## 8. Next execution sequence

- Branch-scoped permissions, branch setup and staff assignment.
- Mobile money provider sandbox adapter, idempotent callbacks, status reconciliation, verified audit events and cash-float ledger (only with licensed operations).
- Real Money Transfer module, with customer KYC, quote, approval, payout claim and reversal paths.
- Banking, Forex, limits, ledger and balance consistency.
- Plan versioning, pricing approval, invoice/payment integrations, reminders and offboarding.
- Notifications, reports for all modules, consolidated analytics and tenant support controls.

**Evidence boundary:** syntax, template rendering, direct HTTP public/access tests and 18 automated tests passed locally. No live MongoDB replica set or payment provider was available for transaction-level integration testing; nothing has been deployed to a user server or pushed to a remote Git repository.

## 9. November 3 local recovery update

- Added repeatable development MongoDB `rs0` provisioning via Docker Desktop on localhost:27018, `db:doctor`, local-only transactional integration probe (`db:integration`) and a clear startup diagnostic. Kept the transaction requirement; no unsafe standalone fallback.
- Readiness now checks for a MongoDB replica-set writable primary, rather than only an open TCP connection. Health checks are exempt from general request rate limiting.
- Fixed an authentication rate-limit bypass: failed sign-ins returned HTTP 303 and were previously excluded because `skipSuccessfulRequests` was enabled. All sign-in attempts now count toward throttling. Regression test proves the ninth request is refused.
- Corrected Mobile Money historical listing: more than 5,000 records no longer prevents a 60-row dashboard list, while large exports still refuse silent truncation.
- Added dependency remediation script and fail-closed GitHub Actions audit gate. The npm security endpoint was inaccessible in this editing session; **the supplied lockfile has not been shown to pass `npm audit` and its reported 12 advisories must be verified/remediated on a connected machine**. See `docs/WINDOWS_STARTUP_AND_SECURITY.md`.
- Still not live-tested against a replica set or provider; real payments remain disabled.
