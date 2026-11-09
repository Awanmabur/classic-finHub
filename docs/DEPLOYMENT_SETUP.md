# MongoDB and service-key setup

Use this checklist before the [production launch runbook](LAUNCH_RUNBOOK.md).
It prepares credentials and infrastructure; it does not deploy the application.
The [operations manual](OPERATIONS_MANUAL.md) covers onboarding and business work
after deployment. Keep filled configuration files and real credentials outside
Git. Enter secret values in the hosting platform's secret settings or protected
host files, never in chat.

## 1. Create the production MongoDB deployment

1. In MongoDB Atlas, create a project dedicated to ClassicFin Hub production.
   Use a production cluster with a replica set, a region near the application,
   and a backup/PITR option that meets the business's recovery requirements.
   Keep development and recovery rehearsals in separate deployments. Do not use
   a standalone MongoDB server: financial writes require transactions.
2. In **Network Access**, allow the application host's fixed outbound IP address
   or establish the intended private connection. Allow an approved administration
   or backup host separately when needed. Do not leave `0.0.0.0/0` as the
   production access list. A private connection still uses TLS.
3. Use `classicfin_platform_db` as the platform database name. The application
   creates its collections and indexes; do not import the uploaded scripts or
   development sample data into production.
4. Plan the first tenant's slug. Slug `kampala-money` maps to database
   `classicfin_tenant_kampala_money_db`; hyphens become underscores. The slug must
   meet the application's validation and be at most 42 characters. Each tenant
   has a separate logical database in the same deployment.
5. Under **Database Access**, create three different database users with different
   strong passwords: one for web/provisioning, one for platform outbox delivery,
   and one for tenant notification/SMS delivery. Atlas account login credentials
   are not application database credentials.

### Assign service access before onboarding a tenant

MongoDB roles cannot express the application's tenant-database naming prefix as
a wildcard. The application does not administer Atlas users or grant MongoDB
roles. Choose and record an access policy before provisioning tenants:

- For a controlled first launch, give the web user `readWrite` on
  `classicfin_platform_db` and each exact planned tenant database. Database-specific
  access can be granted before the tenant database exists. Add the next tenant
  database to this user's roles **before** creating that tenant in Platform Admin.
  Web needs collection/index creation, transactions, sessions, financial records
  and the tenant's other operating collections.
- Use custom roles to restrict worker credentials to their actual collections;
  neither worker needs arbitrary financial writes. Review the table below when
  creating those roles. Add the relevant worker privileges for each new tenant
  before onboarding it.
- Fully automatic creation of arbitrary new tenant databases requires a reviewed
  broader provisioning arrangement. `readWriteAnyDatabase` grants access to
  other databases and is not a prefix-restricted role. Do not quietly use it as
  a least-privilege shortcut. If a dedicated deployment deliberately permits it,
  document that isolation and privilege decision; it is not per-tenant isolation.

Never give application services `root`, `dbOwner`, user-administration or cluster-
administration roles. Provision backup and emergency administration separately.
The real-role review remains necessary even when automated probes pass.

| Principal | Platform database | Each authorized tenant database |
| --- | --- | --- |
| Web/provisioning | `readWrite` for application collections, indexes and persistent sessions | `readWrite` for that tenant's collections and indexes |
| Platform outbox | Find/update and index management on `outboxevents`; find/insert/update/remove and index management on `workerheartbeats` | None |
| Tenant notification/SMS | Read `tenants`; find/insert/update/remove and index management on `workerheartbeats` | Read recipients/preferences and financial source records; find/update notification and encrypted transfer-SMS queue records as listed below |

The notification worker's mail path reads `securetenantusers` and
`notificationpreferencev1` and finds/updates `notificationmessagev1`. The transfer
SMS path finds/updates `transfersmsdeliveryv1` and reads `fundedexecutionv1`,
`transferorderv1` and `securebranches` to check that the collection remains valid.
Worker startup creates/checks heartbeat indexes. Run `npm run indexes` with the web/provisioning
credential before starting workers; do not run index provisioning under a
delivery-only account. No delivery worker needs permission to post financial
journals or alter a customer's balance.

### Obtain three connection strings

Use **Connect → Drivers → Node.js**, copy each service user's actual SRV
connection string directly into its private environment file, and set the
database path to `classicfin_platform_db`. The repository templates deliberately
leave these secret values blank:

```dotenv
PLATFORM_DB_URI=
MONGO_WORKER_URI=
MONGO_NOTIFICATION_WORKER_URI=
```

Use the actual Atlas host and each service's different password.
URI-encode reserved characters in usernames/passwords; a long randomly generated
hexadecimal password avoids those URI characters. Keep all three URIs on the
same deployment and same platform database. Atlas SRV connections use TLS;
do not add `tls=false`, certificate-validation bypasses or `directConnection=true`.
For a self-managed replica set, use its real replica-set hostname list, named
platform database, `replicaSet` and `tls=true`; configure trusted certificates.

### Academy-style variable names and tenant connection links

Use `PLATFORM_DB_URI` for the named platform database and `MONGO_URI_BASE` for
the optional empty-database tenant base. No third web MongoDB variable is needed.
The older `MONGO_PLATFORM_URI` name is still compatible; remove it when using
`PLATFORM_DB_URI` so an old local default cannot conflict with Atlas. If both
platform names are intentionally supplied, they must describe the same database,
deployment, credentials and connection settings.

`MONGO_URI_BASE` is optional. When supplied, its database path must be empty and
its deployment, web user/password, authentication settings, TLS and other driver
options must match the platform connection. Only `appName` may differ. Copy the
same web connection privately and clear its database path. Standard Atlas
`mongodb+srv` pairs may omit `authSource` from both URLs: the connected platform
client resolves the cluster's DNS TXT setting, and derived tenant links explicitly
retain that resolved authentication database. If TXT supplies no authentication
database, links retain the platform client's original authentication database.
The app does not assume `admin` or authenticate separately against each tenant DB.

If you set `authSource` explicitly, set the same value in both URLs (for example,
the `admin` authentication database when correct for your Atlas user). Mixing an
explicit source with an omitted source is rejected. Ordinary authenticated
`mongodb://` platform/base pairs also require the same explicit source. Different
platform and base users remain rejected. `MONGO_URI_BASE` may be left empty;
runtime tenant connections always share the platform client's bounded pool.

Each trusted tenant slug derives its own database name and server-side
connection link. For example, `kampala-money` uses
`classicfin_tenant_kampala_money_db` and `juba-money` uses
`classicfin_tenant_juba_money_db`. Runtime connections reuse one bounded
MongoClient through `useDb`, so a platform authorization fence and tenant ledger
write can commit or roll back in the same transaction. This is separate logical
databases on one deployment, not a separate cluster or database principal per
tenant. Credential-bearing connection links are never shown to tenant users,
returned by public APIs or included in exports.

Workers retain their own service URIs and database principals. They do not need
the web base URI. `REDIS_URL` has no runtime consumer in this application;
persistent sessions and rate limits use MongoDB, so no Redis service is needed
for these workflows.

The deployment host must resolve the Atlas SRV/TXT records and reach the actual
cluster hosts on their configured MongoDB TLS port. Permit HTTPS egress to
`api.resend.com` and, when transfer SMS is enabled, `api.twilio.com`. Keep time
synchronization working for MFA, signed capture messages and dated evidence.

## 2. Generate the application's private keys once

The application uses server sessions; it does not need a JWT access/refresh secret
or a separate cookie-signing key. Generate independent values for these keys:

| Key | Format | Put it in | Keep stable? |
| --- | --- | --- | --- |
| `SESSION_SECRET` | At least 32 characters; 48 random bytes encoded as hex is suitable | Web only | Changing it signs out existing sessions |
| `MFA_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters from 32 random bytes | Web only | Yes: protects stored MFA, Android capture and existing transfer-PIN encryption |
| `TRANSFER_SMS_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters, different from the keys above | Web and tenant notification worker, same value in both | Yes: pending encrypted transfer messages need the original key |

On a trusted Node.js 22+ administration machine, this command creates a new
owner-only file without printing the values or overwriting an existing file:

```bash
umask 077
node -e "const fs=require('node:fs'),c=require('node:crypto');const keys={SESSION_SECRET:c.randomBytes(48).toString('hex'),MFA_ENCRYPTION_KEY:c.randomBytes(32).toString('hex'),TRANSFER_SMS_ENCRYPTION_KEY:c.randomBytes(32).toString('hex')};fs.writeFileSync('/tmp/classicfin-secrets.env',Object.entries(keys).map(([k,v])=>k+'='+v).join('\n')+'\n',{flag:'wx',mode:0o600})"
```

Copy the values privately into the service files below and escrow them in the
organization's secret manager. Remove the temporary file after secure transfer.
Do not rerun key generation during normal releases or rotate the MFA/SMS keys by
simply replacing their values. Existing encrypted records need an explicit,
tested migration/recovery plan.

## 3. Configure recovery and account email

1. Create the mail service account in Resend and verify the sending domain using
   its DNS instructions. A Purelymail/SMTP mailbox password is not a Resend key.
2. Create an API key restricted to the verified sender where supported.
3. Set `RESEND_API_KEY` and `MAIL_FROM`, for example
   `MAIL_FROM='ClassicFin Hub <no-reply@YOUR_REAL_DOMAIN>'`, in web, outbox and
   tenant notification configuration. Use separate scoped API keys where your
   provider/operating policy permits.
4. During deployment acceptance, verify an invitation and password-recovery email
   actually reaches a controlled inbox. Provider acceptance alone is not mailbox
   delivery. Configure SPF/DKIM and the intended DMARC policy before launch.

## 4. Configure receiver transfer SMS

Outbound transfer SMS and inbound Android Mobile Money capture are different
features. Android capture credentials are enrolled per device in the application;
they are not Twilio credentials. Receiver SMS uses a configured Twilio account
and the existing tenant notification worker.

1. In Twilio, obtain the account SID and auth token. Enable SMS for the actual
   destination countries and follow the required sender/traffic registration.
   A trial account normally restricts recipients; use the appropriate live
   account for real customers.
   Copy them into `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in the notification
   worker file. The account SID begins with `AC`; a Messaging Service SID begins
   with `MG`. These are issued by Twilio, not generated by the application.
2. Choose **one** supported sending identity: an SMS-capable `TWILIO_FROM_NUMBER`
   in international `+` format, or a `TWILIO_MESSAGING_SERVICE_SID`. Do not set both.
3. Configure web and the tenant notification worker with
   `TRANSFER_SMS_PROVIDER=twilio` and the same `TRANSFER_SMS_ENCRYPTION_KEY`.
   Put Twilio credentials in the notification worker's private configuration.
   Web needs the encryption key to enqueue the message; it does not need the
   Twilio auth token to post a collection.
4. After an authorized independent reviewer posts a real collection, the system
   generates the payout PIN and atomically queues the encrypted receiver message.
   Merely saving a transfer request does not generate a payable transfer or send
   the PIN. The SMS contains the transfer reference, amount, PIN, sender details
   and collecting branch. New payouts are checked with the PIN and sender phone.
5. Inspect the transfer's SMS status and the provider's message record during a
   controlled live test. `Provider accepted` means Twilio accepted the request,
   not that a handset received it. Check actual receipt. An uncertain send outcome
   stops automatic sending and cannot be retried through the normal retry button.
   Inspect the provider record and use the controlled handoff/support procedure;
   do not assume that no response means no SMS.

Generate and install the dedicated encryption key in web and the worker before
the first transfer even if outbound SMS will initially be disabled. This keeps
an encrypted queued handoff available for a permitted later retry. If a transfer
was collected with neither a configured provider nor this key, the authorized
one-time manual PIN display remains the handoff; after that display, the system
cannot reconstruct a new SMS from a deleted PIN. Do not rotate keys or create a
replacement transfer to work around this protection.

Use `TRANSFER_SMS_PROVIDER=none` when outbound SMS is deliberately unavailable.
The UI records that it is not configured and preserves the authorized one-time
manual PIN handoff. It never reports a simulated successful send. This fallback
does not satisfy acceptance of automatic receiver SMS.

Existing collected transfers retain their original receiver-phone PIN matching
mode. Follow the explicitly labelled legacy-phone control for those records;
new collections use sender-phone matching. Do not alter historical party records
to make a PIN match.

## 5. Create private service configuration files

On the Linux deployment host, use three distinct protected files outside the
repository and web directory:

| Template | Private file | Main values |
| --- | --- | --- |
| `deploy/web.env.example` | `/etc/classicfin/web.env` | Actual `APP_URL`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `PLATFORM_DB_URI`, email, transfer-SMS provider and encryption key |
| `deploy/worker.env.example` | `/etc/classicfin/worker.env` | Actual `APP_URL`, dedicated `MONGO_WORKER_URI`, email credentials, `OUTBOX_POLL_MS=2000` |
| `deploy/notification-worker.env.example` | `/etc/classicfin/notifications.env` | Actual `APP_URL`, dedicated `MONGO_NOTIFICATION_WORKER_URI`, email, transfer-SMS configuration and Twilio credentials, `NOTIFICATION_POLL_MS=5000` |

Use file mode `0600` and directory mode `0700`. Production uses
`NODE_ENV=production`, the real HTTPS origin in `APP_URL`, `REAL_MONEY_ENABLED=false`
and `PORT=3000` inside the web container. The supplied single reverse proxy uses
`TRUST_PROXY=1`; change it only to match a verified actual topology. Use
`SEO_INDEXING_ENABLED=false` on staging and `true` only on the intended public
production domain. Never share a redacted-looking file that still contains real
keys, a database password, complete connection strings or gateway secrets.

No Stripe/PesaPal/PawaPay/Eversend, generic SMTP, Yo! API, JWT, OAuth or object-
storage key activates an unimplemented adapter. Leave unrelated provider fields
out. Internal financial-evidence HMAC keys are optional until their separately
verified adapter is deliberately used; they are not required for manual funds
or transfer SMS. Redis is not required by the current persistent-session path.

For Atlas, configure provider-native backups/PITR and rehearse restoration into a
separate isolated deployment. The repository's `mongodump --oplog` backup path is
for its supported self-managed replica-set topology; do not assume it works with
Atlas or that a successful local archive proves an Atlas restore. For supported
self-managed backups, use the separate backup/offsite/alert templates in the
launch runbook. Never give web containers backup or cloud root credentials.

## 6. Verify configuration, initialize and then deploy

Follow the launch runbook for the tested immutable image, TLS, proxy, registry,
release selectors and rollback. In a trusted private operator shell, load only
the three operator-owned environment files:

```bash
set -a
. /etc/classicfin/web.env
. /etc/classicfin/worker.env
. /etc/classicfin/notifications.env
set +a
npm run production:check -- --config-only
```

The probe reports check names, not secret values. Configuration-only mode does
not connect to Atlas or prove delivery. Run `npm run indexes` once using the
tested artifact and web/provisioning environment before startup; back up before
upgrading existing data. Never run the local `release:gate` with production URIs.

For a brand-new installation only, create the initial platform administrator
through `npm run bootstrap`, using `BOOTSTRAP_ADMIN_EMAIL`,
`BOOTSTRAP_ADMIN_NAME` and an owner-only `BOOTSTRAP_PASSWORD_FILE` containing a
password of at least 14 characters and at most 72 UTF-8 bytes, with uppercase,
lowercase, digit and symbol. Do not put that
password in the command line or commit the file. Remove the file after successful
bootstrap, sign in, enroll MFA, publish plans and test the owner's invitation.
An upgrade does not require bootstrap and must not reset existing accounts.

Authenticator enforcement is controlled by `MFA_ENABLED`. An explicit `false`
permits password-only setup. An absent or blank value disables enforcement
outside production and enables it with `NODE_ENV=production`; an invalid nonempty
value enables enforcement. Set it to `true` and restart when ready to require
enrollment/challenges. The startup `app.ready` event reports the effective version,
MFA mode and configuration source. Exported process settings take precedence over
`.env`. Keep `MFA_ENCRYPTION_KEY` unchanged in both modes: it also protects Android
capture and existing transfer-PIN data. Enabling the requirement rejects sessions
established without genuine MFA verification.

The web MongoDB pool defaults to 30 connections (`MONGO_POOL_MAX`, integer 1–200).
Server selection and connection each have a 7-second bound, pool checkout a
5-second bound and inactive sockets a 30-second bound. These individual limits
do not impose a whole-operation deadline or replay an application write. Known
storage availability failures return 503 with `Retry-After`; investigate ambiguous
write outcomes by reference before retrying. The session expiry index is awaited
before HTTP startup, and unchanged session expiry touches are coalesced for up to
60 seconds. Session saves, authorization changes and logout are not deferred.

Tenant setup batches declared indexes by collection while retaining their options
and uniqueness enforcement. Tenant read handles disable implicit index creation;
the explicit provisioning/index procedure remains required. Test actual Atlas
latency and capacity with the intended region, roles and workload before launch;
local probe timings do not measure the remote deployment.

Start all three supervised services from the same immutable image:

- Web application: `npm start`.
- Platform subscription outbox: `npm run worker`.
- Tenant notification and transfer-SMS delivery: `npm run worker:notifications`.

The third service handles transfer SMS even when the optional internal staff
Notifications module is not subscribed. It still needs its queue/source database
privileges and the configured SMS key/provider. Install the supported expiry,
backup and health timers described by the runbook; a running web process is not
a background scheduler.

After activation, run `npm run production:check -- --live` and the runbook's other
read-only probes, check worker-class heartbeats, perform controlled real email
and receiver-SMS tests, complete role/branch/MFA and responsive browser smoke,
and verify recovery evidence before opening normal operations. These steps
establish the actual deployment evidence that repository tests cannot supply.


## Tenant Drive archives and offline devices

Version 1.25 adds a separately supervised tenant backup worker, private persistent archive mount, Google OAuth callback and offline draft capture. Follow [Tenant backups and offline operations](TENANT_BACKUPS_AND_OFFLINE.md) for its exact keys, least-privilege role requirements, optional Compose overlay, schedule, recovery and limits. Google/Yoola are not activated by a successful local test.
