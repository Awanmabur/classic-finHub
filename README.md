# ClassicFin Hub 1.26.2

A multi-tenant platform for reviewed manual financial operations, configurable subscriptions, branch-based administration and separately licensed Android SMS capture.

The tenant workspace follows the approved `index.html` design. Its navigation displays subscribed modules, and tenant owners and auditors can view Main, another branch or all branches. Daily transactions retain their assigned operating branch. Wallet setup and working instructions are available from Tenant profile.

## Implemented workflows

- Platform administrators publish versioned plans with modules, prices, quotas and higher-priced SMS-assisted tiers; provision tenants; and manage manual subscription grants.
- Mobile money cash-in/out uses configured wallet and payment-account defaults. Wallets provides account setup, reviewed opening evidence, funding transfers, fee policy and reconciliation.
- Each branch supports its selected UGX, USD, SSP and KES currencies with separate accounts, verified cash shifts and ledger totals. MTN SSD (South Sudan) is available separately from MTN in manual entry and supported Android SMS capture.
- Banking, forex, money transfers and expenses use independently reviewed manual postings, exact currency amounts, balanced journals, immutable source records and controlled corrections.
- Money transfer tellers type sender and receiver details directly. Reviewed collection generates a PIN and queues receiver SMS when configured; new payouts match the PIN and sender phone in the selected receiving branch. Saved contacts are optional.
- Tenant Workspace checks actual branch assignments, independent reviewers, funds accounts, verified cash shifts and subscribed operation prerequisites, and links to current review queues.
- Customers, accounts, branches, staff, notifications, reports, analytics and audit views follow subscription, role and branch permissions. Reporting filters and controlled exports remain available.
- Onboarding appointments support scheduling, rescheduling, cancellation and completion with an audited decision history.

Manual books and dated SMS/count/statement observations do not execute a provider payment or supply a live external balance. Keep `REAL_MONEY_ENABLED=false`. Automatic payment collection/invoicing, live provider settlement and disabled products are outside this launch scope.

## Launch documentation

Use the [end-to-end operations manual](docs/OPERATIONS_MANUAL.md) for platform onboarding, plan configuration, tenant setup, every operating module, reviews, reports, daily closing and incident procedures. Download the [PDF](docs/operations/OPERATIONS_MANUAL.pdf) or [editable Word copy](docs/operations/OPERATIONS_MANUAL.docx).

Start with the [launch status](docs/LAUNCH_STATUS.md) and follow the [production runbook](docs/LAUNCH_RUNBOOK.md) in order. It covers service credentials, HTTPS, database roles, immutable images, migrations, initial administrator setup, backups/restore, workers, monitoring, smoke checks and rollback.

For first setup, use the [MongoDB Atlas and service-key checklist](docs/DEPLOYMENT_SETUP.md). It explains which credentials to create, where they belong, and which optional keys can stay blank.

Use `PLATFORM_DB_URI` for the named platform database. Optional `MONGO_URI_BASE`
has an empty database path and derives private tenant links using the same deployment
and web credential. Each tenant keeps its own logical database while sharing one
bounded MongoClient for atomic authorization and financial writes. Redis is not
required by the current runtime.

These are the only web MongoDB settings needed. The older `MONGO_PLATFORM_URI`
name remains compatible; remove it from your `.env` when using `PLATFORM_DB_URI`
so an old local URI cannot conflict with your Atlas setting. Matching Atlas SRV
pairs can omit `authSource` from both URLs. See the [Windows update recovery steps](docs/WINDOWS_STARTUP_AND_SECURITY.md#recover-an-update-blocked-by-local-files)
if `git pull` aborts before updating the running code.

The application includes a read-only production probe:

```bash
npm run production:check -- --config-only
npm run production:check -- --live
```

Run it with the real deployment configuration. Configuration-only mode does not test the host. The report deliberately lists remaining restore, delivery, access and capacity evidence; it does not issue a production certification.

## Local development

Use Node.js 22 or newer and a transaction-capable MongoDB replica set. Docker Compose can provide the isolated local replica set.

```bash
npm ci
cp .env.example .env
npm run dev:local
```

`dev:local` loads `.env` before selecting the authenticator key and starts the development database on loopback port 27018 and persists a private, Git-ignored development MFA key. It must not run with production data or settings. See [cloud setup](docs/CLOUD_SETUP.md) and the [Windows startup guide](docs/WINDOWS_STARTUP_AND_SECURITY.md) for platform-specific details.

There are no seeded administrator credentials. Follow the protected password-file bootstrap procedure in the production runbook or `scripts/bootstrap.js`, then enroll MFA through sign-in.

## Verification

```bash
npm run check
npm run secrets:check
npm test
npm run release:gate
```

Run the release gate against isolated staging/local infrastructure. Its integration scripts enforce loopback scratch databases and must never run on production. Browser and repository evidence is recorded under [docs/review](docs/review), with the latest launch results in the launch status document.

## Security and public discovery

Financial and administrative routes require authentication, scoped permissions and privileged MFA. Private responses are no-store/noindex. Public marketing pages provide canonical metadata, structured data, a public-only sitemap, robots policy and `llms.txt` guidance. Crawler permission does not guarantee search indexing or AI inclusion. Staging disables indexing.

Use protected environment files and distinct service identities; never commit keys, passwords, backup material or tenant data. Live HTTPS, delivery and recovery must be verified on the actual deployment.

## Guides and maintenance

- [Manual funds, wallets and branch views](docs/MANUAL_FUNDS_AND_UI.md)
- [Customers and internal accounts](docs/CUSTOMERS_AND_ACCOUNTS.md)
- [Tenant workspace configuration](docs/TENANT_WORKSPACE_CONFIGURATION.md)
- [Plans and Android SMS capture](docs/SMS_AND_PLAN_CONFIGURATION.md)
- [Android relay setup](tools/android-sms-relay/README.md)
- [Launch UI and navigation](docs/LAUNCH_UI.md)
- [Verified dead-code removal manifest](docs/DEAD_CODE_CLEANUP.md)
- [Current review register](docs/PROJECT_REVIEW.md)

The active entrypoints are `src/server.js`, `src/app.js`, the mounted public/platform/tenant routers and the separately supervised workers. The root `index.html` is retained as the approved design reference and stylesheet-generation fixture.

Branch delivery, offline pending drafts, Google Drive archives and their deployment/recovery procedures: [Tenant backups and offline operations](docs/TENANT_BACKUPS_AND_OFFLINE.md).

If sign-in fails after an update, run `npm ci` before restarting. Keep the original `MFA_ENCRYPTION_KEY`; do not generate a replacement for existing enrollments. Plain development startup can reuse an existing private `.classicfin-dev-mfa.key`, while production requires its explicit key. See [sign-in troubleshooting](docs/WINDOWS_STARTUP_AND_SECURITY.md#sign-in-after-an-update).
