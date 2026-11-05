# ClassicFin Hub v1.3 — verified implementation, operational evidence and release gates

Date: 3 November 2026. This release is an improvement to the existing ClassicFin Hub Node/Express/EJS application, **not a replacement design**. The dashboard CSS is byte-for-byte unchanged. No actual payment service or external MongoDB instance was accessed during this build.

## Implementation delivered

### Identity and tenant security

- Sign-in remains **email + password only** and sends tenant users to their server-verified tenant dashboard; there is no form field for tenant, role or dashboard type.
- **Super Admins must complete a separate authenticator-app step** after password verification. First authenticated login enrolls a 20-byte TOTP secret; a valid six-digit code is mandatory before granting the platform session. Returning administrators verify one-time codes; accepted counters advance atomically to reject concurrent replay.
- Admin TOTP secrets are AES-256-GCM encrypted at rest using `MFA_ENCRYPTION_KEY` (64 hex characters). The key must be stable, private, backed up separately, and accessible only to the app/runtime administrator. **Changing the key without re-encrypting enrolled secrets locks out administrators.**
- Enrollment is bound to a five-minute pending session with at most five incorrect attempts; full administrator sessions are regenerated only after TOTP verification. Enabling MFA invalidates existing sessions through `authVersion`; full admin route protection also requires recent MFA verification.
- Privileged recovery is an **offline** command requiring an existing administrator's current password in a protected local file, an exact approval phrase, and database access. It revokes sessions and writes platform audit/security events. It does not support web-based MFA bypass. See command below.
- Tenant email/password roles remain as before. **Tenant-owner and staff MFA are not yet enforced**; do not claim a universally MFA-protected financial platform.
- Financial recording routes now have atomic database-backed per-user and per-tenant rate budgets (120/user/minute; 600/tenant/minute); public enquiry forms have a shared 10/IP/hour budget. Existing shared sign-in throttles are retained.
- Sessions now have a 30-minute sliding idle cookie lifetime and an eight-hour absolute authentication lifetime. Active tenant/user/status and role permissions are verified on protected requests.
- Retired pseudo-financial services and background jobs **fail closed** instead of producing fake successful payments, ledger posts, backups, notifications or job-completion logs. The active mobile-money recording-only service remains unchanged.
- Logs are structured JSON containing a request ID, method, truncated safe path, status and duration. They do not include passwords, cookies, URL query values or request bodies.

### Speed and deployment

- `bg.jpg` → `bg.webp`: 1,675,862 → 107,040 bytes (93.6% smaller).
- `prt.jpg` → `prt.webp`: 1,731,932 → 283,248 bytes (83.6% smaller).
- `fx.jpg` → `fx.webp`: 80,981 → 37,648 bytes (53.5% smaller).
- Image dimensions, lazy loading for off-screen photographs, `fetchpriority` for the homepage preview and content-fingerprinted asset URLs reduce transferred bytes and layout shifts without redesigning the site. Original JPG assets remain for compatibility; served templates use WebP.
- New compound tenant transaction indexes support operator/date and status/date queries. Existing bounded connection-pool/database-per-tenant design is retained; there is **no unverified performance claim about large tenant counts**.
- HTTP image files are cacheable for 7 days; scripts and styles for 1 day. HTML forms and private pages are non-cacheable; this avoids caching personal or CSRF state across visitors.
- Response compression, request ID tracing, readiness via writable Mongo primary, and graceful HTTP shutdown are supported.
- `deploy/Dockerfile` runs as the unprivileged `node` user; `deploy/compose.prod.yml` uses a read-only container root, dropped capabilities, localhost-only published port, resource limits, health checks and bounded logs. `deploy/Caddyfile.classicfin.example` is a template: **do not use its placeholder domain or port without checking the server**.
- Morgan and Nodemon were removed from direct dependencies. Node 22's watch mode replaces Nodemon. The lockfile was refreshed offline. A **successful current `npm audit` was not possible** because npm registry DNS is unreachable in the build environment.

### Public search / AI discoverability

- Each indexable public marketing page includes its own canonical, Open Graph/Twitter metadata, and schema.org Organization/WebSite or BreadcrumbList JSON-LD; the JSON-LD nonce matches the Content Security Policy.
- XML sitemap lists public marketing URLs only. Private dashboards, sign-in, invitations, admin MFA, tenant public landing pages and health endpoints do not appear in the sitemap.
- `robots.txt` permits public crawlers in **production only**, denies private route prefixes and advertises the sitemap. Development and production instances with `SEO_INDEXING_ENABLED=false` use `Disallow: /` plus a noindex header. A staging copy should always set this flag to `false`.
- `/llms.txt` is an optional public information guide for tools that read it; it does **not** itself improve Google Search or Google AI visibility. Google explicitly says it does not rely on llms.txt for Search. Normal technical SEO, crawlability and useful content matter more.
- 404/private/auth pages emit `X-Robots-Tag: noindex` and appropriate no-store caching; authenticated financial pages never become public crawler resources.
- Canonical origin HTTPS host enforcement is active in production. The reverse proxy must send correct forwarded HTTPS signals and be the only trusted proxy. Alternate `www` requests redirect to the configured canonical host.

## Verified locally

- `npm run check` — EJS compilation and JS syntax checks (321+ files).
- `npm test` — 37+ automated tests including MFA encryption/TOTP/replay, account/role authorization, CSRF, SEO metadata, noindex, HTTP performance asset handling and financial-data validation.
- `npm run perf:assets` — WebP image size budgets.
- `npm run perf:smoke` — six non-database public/static paths, 48 local HTTP responses. **This only measures the local Node process.** It does not measure real user Core Web Vitals, database query performance or production throughput.
- Original `public/css/dashboard.css` SHA-256 remains `d934211d1b124df7142c38b9f6e25f67f480b0725208d190de9577b70730a40c`.

## Windows developer workflow

Use the updated files or validate/apply the v1.2.0 → v1.3.0 Git patch **only if** the repository matches the previous release. Preserve uncommitted work and `.env` before updating.

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up
npm run dev:local
```

`dev:local` creates a Git-ignored, owner-only `.classicfin-dev-mfa.key` on first launch and reuses it across restarts. Do not copy this development key into production. Node 22+ and Docker Desktop are required for this local Docker workflow. If you run `npm run dev` directly, configure a stable `MFA_ENCRYPTION_KEY` yourself.

## Production setup / deployment gate

1. Take an application and database backup; rehearse restoration separately. Use an approved domain, HTTPS/Caddy, a secured external Mongo replica set, least-privilege DB user and protected server secrets. Never expose Mongo directly on public ports.
2. Configure `NODE_ENV=production`, `APP_URL=https://YOUR-REAL-DOMAIN`, `TRUST_PROXY=1`, `SESSION_SECRET` (strong random 32+ characters), `MFA_ENCRYPTION_KEY` (32 random bytes encoded as 64 hex characters), `MONGO_PLATFORM_URI`, a verified sender (`RESEND_API_KEY`, `MAIL_FROM`), and `SEO_INDEXING_ENABLED=true` **only for the actual public production domain**.
3. Run `npm ci`, `npm audit --audit-level=high`, `npm run check`, `npm test`, `npm run indexes`. Resolve high/critical audit findings; do **not** bypass CI with `--force` or `--no-audit` for release validation. The Docker build uses `--no-audit` to avoid nondeterministic audit network traffic at image-build time; CI owns the audit gate.
4. Run `npm run db:doctor`. Complete the existing global login identity migration if upgrading (`npm run auth:migrate`, then `npm run auth:migrate -- --apply`). The migration must not run concurrently with uncontrolled account creation.
5. Run `npm run auth:integration` and `npm run db:integration` only on **isolated, loopback-only test MongoDB**. Verify real production login and separate tenant access through a controlled smoke test with test accounts, not by running destructive integration scripts against production.
6. Create the initial Super Admin with `npm run bootstrap` only on an empty platform account directory. Immediately enroll its authenticator app before opening platform access. Test sign-in, TOTP replay rejection, staff disable, CSRF, expired invitations, password reset emails, and audit records.
7. Build the container and validate reverse proxy config and infrastructure port availability. Observe actual traffic, status codes, resource usage, logs and error rate. Test concurrency, incident recovery, backup restore, alerting and rollback.
8. Use Search Console URL Inspection, sitemap submission, robots testing, and real browser Lighthouse/Web Vitals after DNS deployment. Check that live crawlers see a **200 HTTPS page**, canonical metadata and no robots/noindex restriction on production marketing URLs. AI inclusion and rankings are not guaranteed.
9. **Do not enable real-money features** until the licensed provider integration, callbacks, signature verification, exact settlement reconciliation, double-entry ledger, KYC/AML controls, fraud management and external review are implemented and independently tested.

### Emergency administrator authenticator recovery

Run only from an authorized operations shell with recorded change approval. Replace the email, store the **current existing administrator password** in an owner-only file, and quote the exact confirmation phrase:

```bash
MFA_RECOVERY_EMAIL='admin@your-domain.example' \
MFA_RECOVERY_PASSWORD_FILE='/secure/private/current-admin-password' \
MFA_RECOVERY_CONFIRM='RESET MFA FOR admin@your-domain.example' \
npm run admin:mfa-recover
```

On the next email/password sign-in the administrator must enroll a fresh authenticator. Delete the temporary password file securely. If the password is also lost, use the separately controlled offline password recovery procedure first.

## Remaining blockers — do not label these production-ready

- npm registry audit and remediation remain unverified; `npm ci` could not be executed in a clean offline install because a transitive tarball was not cached. **A connected build machine must prove clean installation and acceptable advisories.**
- The MongoDB integration suite, privileged authentication integration suite, live mail delivery and restore drill could not run here (no Docker/Mongo/network access).
- Tenant-owner/staff MFA, account-device management, off-host immutable audit/WAF/alerting, CSP removal of legacy inline styles, performance testing under real data, tenant-lifecycle offboarding and tenant-specific backup/restore remain incomplete.
- Money Transfer, Banking, Forex, provider settlement, plans billing/collections and background jobs are still disabled or not implemented. Their legacy demonstration entrypoints now fail closed. Do not advertise them as processing real payments.
- For actual financial service operations, additional jurisdiction-specific regulatory, compliance, privacy and independent security validation is necessary. No code-only change can prove 100% security.
