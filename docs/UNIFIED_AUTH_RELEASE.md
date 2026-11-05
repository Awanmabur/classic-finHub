> **Historical v1.2 guide:** v1.3 adds Super Admin MFA, safer deployment, updated SEO and other changes. For current instructions use [v1.3 release guide](SECURITY_PERFORMANCE_SEO_RELEASE_V1_3.md).

# ClassicFin Hub v1.2 — Unified email/password login

**Scope:** Login, Super Admin initialization, global identity mapping, tenant/staff activation, session revocation, password recovery, and role-based dashboard routing. Existing dashboard stylesheet and visual structure are unchanged. This is a complete account-routing code change; it is **not** a financial production/security certification.

## User experience

`/signin` shows exactly two visible data fields: **Email address** and **Password**. The hidden CSRF field is required for request integrity, not an extra user field. No dashboard, role, organization, or tenant slug selector exists. A verified Super Admin is sent to `/platform/dashboard`; an active tenant owner/staff member is sent to `/tenant/dashboard`. An invalid, duplicate, disabled, or unmapped account fails closed. Tenant-specific permissions and module entitlements determine visible sidebar entries and server access.

**Email uniqueness requirement:** One email belongs to exactly one platform account OR one tenant account. If staff need memberships in several tenants under one email, that is a separate product design (account picker/tenant switcher with membership checks); it cannot be safely implemented by guessing a tenant on login. This release deliberately refuses duplicate emails across accounts.

## Before upgrading an existing local/production database

1. **Back up the database and application files** and verify the backup restores. Schedule a controlled release/maintenance window; old instances must not keep accepting invitations during migration.
2. Replace the project source while keeping your `.env`, any data and uncommitted work safe. Extract files to the project root, where `package.json` resides; do not run `npm ci` from a nested folder.
3. Ensure Node.js 20+, a writable MongoDB replica-set primary, configured `APP_URL`, `MONGO_PLATFORM_URI`, and a 32+-character production `SESSION_SECRET`. Check `npm run db:doctor`.
4. Run `npm ci`, `npm run indexes`, `npm run auth:migrate` (**read-only directory audit**). Fix every duplicate/invalid account email reported. Never let a script assign an ambiguous email to the wrong tenant.
5. Run `npm run auth:migrate -- --apply`. This creates only missing account-directory entries, verifies mappings, does not change passwords, and can be rerun after an interruption. Accounts not migrated cannot sign in through the new email-only route.
6. Run `npm run check`, `npm test`, and `npm run auth:integration` **against local development MongoDB**, not live/production. `auth:integration` requires a reachable loopback MongoDB replica set, uses random temporary test accounts, and cleans up only its own scratch data. It is not an Atlas/production test.
7. Resolve npm's high/critical and remaining applicable advisory findings, and configure/test recovery mail delivery. See `docs/WINDOWS_STARTUP_AND_SECURITY.md`. Only then promote the release behind HTTPS with staged monitoring, rollback, and a tested database restore plan.

### Creating the very first Super Admin (new database only)

The app **never seeds default credentials**. Run the one-time bootstrap from your trusted machine after configuring MongoDB. In Git Bash on Windows (the directory containing `package.json`):

```bash
# Start the isolated replica set if using Docker Desktop; set .env to port 27018.
npm run db:dev:up
npm run db:doctor
# Never put the password in CLI arguments, Git history, or a tracked config file.
read -rsp 'Choose strong Super Admin password: ' ADMIN_PASSWORD; echo
(umask 077; printf '%s' "$ADMIN_PASSWORD" > .admin-bootstrap-secret)
unset ADMIN_PASSWORD
BOOTSTRAP_ADMIN_EMAIL='replace-with-your-real-admin-email@example.com' \
  BOOTSTRAP_PASSWORD_FILE="$(pwd)/.admin-bootstrap-secret" npm run bootstrap
rm -f .admin-bootstrap-secret
```

Windows ACLs should also restrict the secret file to your account. On Linux the CLI enforces owner-only permissions. The new Super Admin signs in at `/signin` with those credentials; the account automatically enters the platform dashboard. Bootstrap is permanently one-time; if an admin exists, use account recovery instead of recreating a privileged user. Do not execute against a production database without change control.

**Existing database:** If it already contains Super Admin accounts, do **not** run bootstrap. Run `auth:migrate` to map their existing emails. Existing password hashes remain usable.

### New tenant owner and staff

Only a verified Super Admin may create a tenant; its owner is activated from a one-use, 48-hour invitation. Tenant owners can invite supported staff roles with one-use, 24-hour invitations and seat checks. The invitation tokens travel in URL fragments, not HTTP GET query strings. Activation creates the tenant account and global identity record atomically in a Mongo transaction. Role permissions are fixed by the server and checked again on every request. An already registered email cannot be activated for a second account.

### Recovering lost passwords

The existing forgot/reset forms are now wired to a real service, not a mock:

- Configure `RESEND_API_KEY` and a verified `MAIL_FROM` email identity; set `APP_URL` to your real HTTPS domain in production. The provider uses `POST https://api.resend.com/emails`, with a 10-second timeout. A submission without delivery configuration returns HTTP 503, **not** a fake confirmation.
- A reset request returns a generic response regardless of whether an account exists, and has shared database rate limits. If an active account exists, a fresh 64-hex-character random token is emailed in the URL fragment and stored **only as a SHA-256 hash** in the database. The link expires in 15 minutes.
- The reset form confirms the new password and checks its strength. Changing a password atomically updates the account, increments `authVersion`, deletes all outstanding reset links, and logs a security event. Existing sessions are rejected on subsequent requests; a new login is required.
- Provider acceptance is not proof of inbox delivery. Conduct a real email-delivery test (including SPF, DKIM, DMARC, spam handling) before declaring production recovery ready. SMTP on Purelymail is **not** connected by this version; do not enter Purelymail SMTP credentials into the Resend API fields.

### Running locally

```bash
cp .env.example .env
# Edit .env: use the local replica-set URI 127.0.0.1:27018, set APP_URL and SESSION_SECRET.
npm ci
npm run db:dev:up
npm run db:doctor
npm run indexes
npm run auth:migrate
npm run auth:migrate -- --apply
npm run auth:integration
npm run dev:local
```

For production, use `npm start` behind a trusted HTTPS reverse proxy, real session secret, authenticated MongoDB replica set, monitoring, and tested backups; never use the unauthenticated Docker development database on the public internet.

## Current release gates (do not relabel as passed)

- **Must complete externally:** MongoDB integration test, live recovery email acceptance *and delivery*, production environment configuration, and npm advisory remediation (the user's earlier `npm ci` reported 12 advisories). `npm audit --offline` reporting zero does **not** prove those advisories were fixed.
- **Financial/admin security:** Enforced phishing-resistant MFA or equivalent for Super Admin/high-risk actions, strong CSP without unsafe inline execution, provider callbacks/reconciliation, independent ASVS/pentest, load tests, backup restore, logging/alerting and an incident runbook.
- **Financial operations:** Mobile Money remains **recording-only/unverified**; payouts, money transfer, banking, forex settlement and other unfinished workflows must not be represented as live.
- **Architecture:** Shared MongoDB pool with per-tenant logical databases suits an initial bounded deployment; stress-test database metadata/connection memory, tenant count, and migrations before promising large-scale multi-tenant performance.

This release also removes inline script execution from the active site/dashboard CSP; inline style attributes remain until a separate CSS cleanup. The release closes the user's requested **two-field sign-in and automatic dashboard routing** in source code with a runnable verification suite. It does not assert that external deployment or regulated financial operations have passed production gates.

## Offline Super Admin recovery (emergency only)

If password-reset email is unavailable but the platform already has an active Super Admin, a trusted server operator may use `npm run admin:recover`. This updates only the named existing active Super Admin account, checks the unique directory mapping, increments its session version and creates a durable security event. It cannot create new administrators or elevate tenant users. Have the operator record the approval and change ticket externally.

```bash
read -rsp 'New strong Super Admin password: ' ADMIN_PASSWORD; echo
(umask 077; printf '%s' "$ADMIN_PASSWORD" > .admin-recovery-secret)
unset ADMIN_PASSWORD
ADMIN_RECOVERY_APPROVED=YES \
  ADMIN_RECOVERY_EMAIL='your-registered-admin@example.com' \
  ADMIN_RECOVERY_PASSWORD_FILE="$(pwd)/.admin-recovery-secret" npm run admin:recover
rm -f .admin-recovery-secret
```

**Never** publish recovery scripts over HTTP or grant normal application users access to MongoDB credentials. Access is limited by OS/database permissions, and the operation must be reviewed as a privileged emergency action.
