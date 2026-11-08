# ClassicFin Hub 1.24.0 launch runbook

This is a launch candidate for the implemented manual financial books and separately licensed Android SMS capture. `REAL_MONEY_ENABLED=false` remains mandatory. An internal posting, reviewed balance or provider email acceptance does not certify external payment settlement. [Launch status](LAUNCH_STATUS.md) separates repository verification from checks still required on the real host.

## 1. Establish the deployment boundary

Enable reliable time synchronization on application, database and operator devices. Financial timestamps and appointment scheduling identify UTC explicitly. Use a patched Linux host, Docker with the Compose plugin, `curl`, `flock`, a TLS reverse proxy, and an authenticated TLS-protected MongoDB replica set. The shipped production Compose deliberately does not create a public database. Restrict database ingress to the application and approved backup hosts. Expose only HTTPS through the proxy; web port 3500 binds to loopback and workers have no inbound ports.

Use three different database principals: web/provisioning, outbox worker and tenant notification worker. Review their actual roles. Do not use root, user administration or cluster administration roles for services. Web needs the application platform/tenant namespaces; notification worker needs its tenant notification namespaces; outbox worker needs the platform outbox and heartbeat collections. Provision backup/recovery credentials separately. Logical tenant databases share an application deployment and do not constitute separate clusters.

The web platform URI may use `PLATFORM_DB_URI` instead of `MONGO_PLATFORM_URI`.
Set one, or equivalent values for both. Optional `MONGO_URI_BASE` must leave the
database path empty and match the same web principal, deployment, explicit
authentication source, TLS and driver settings; only `appName` may differ.
See [deployment setup](DEPLOYMENT_SETUP.md) before copying Academy-style settings.
Redis is not used for current sessions or rate limits.

The [MongoDB and service-key checklist](DEPLOYMENT_SETUP.md) gives Atlas setup,
per-tenant role provisioning and the exact active key inventory. The tenant
notification worker also processes encrypted receiver transfer-SMS delivery;
grant its documented queue/source reads without granting financial write access.

Choose the real canonical domain, sending domain and recovery mailbox. Configure DNS and a valid HTTPS certificate. `deploy/Caddyfile.classicfin.example` is a template: replace both domain blocks, validate Caddy, and test the real host. With the shipped single-hop proxy, set `TRUST_PROXY=1`; use 2 only after validating an actual two-hop topology. Do not trust arbitrary forwarded headers.

## 2. Prepare private service configuration

Create private host files outside the checkout/public directory, mode 0600, accessible only to the deployment operator. Copy these templates and replace every placeholder:

- `deploy/web.env.example` → `/etc/classicfin/web.env`
- `deploy/worker.env.example` → `/etc/classicfin/worker.env`
- `deploy/notification-worker.env.example` → `/etc/classicfin/notifications.env`
- `deploy/backup.env.example` and `deploy/alert.env.example` → separately protected backup/monitoring configuration

Generate independent strong session and MFA encryption keys. Keep the MFA key stable across application upgrades: replacing it without an explicit migration makes existing encrypted MFA/SMS data unreadable. Escrow the backup encryption key separately from archives and application secrets. Never put populated environment files, credentials or backups into Git, images or support messages.

Generate a separate `TRANSFER_SMS_ENCRYPTION_KEY` (64 hexadecimal characters)
and put the same value in web and the tenant notification worker. Keep it stable
so queued encrypted messages remain readable. Set `TRANSFER_SMS_PROVIDER=twilio`
in both when enabling receiver messages; Twilio account/authentication/sender
credentials belong only in the notification worker. Set exactly one
`TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`. `none` is an explicit
manual-handoff fallback, not evidence that automatic SMS has been configured.

Web requires explicit `NODE_ENV=production`, actual HTTPS `APP_URL`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `MONGO_PLATFORM_URI`, valid `PORT` and `TRUST_PROXY`, and `REAL_MONEY_ENABLED=false`. Configure Resend and a verified `MAIL_FROM` before accepting users who need invitations/recovery. Both worker files require their own database URI and mail configuration. All URIs identify the same platform database/replica set. Use TLS on private database connections too. In the app's manual mode, trusted gateway evidence HMAC keys are optional until a corresponding adapter is deliberately enabled.

Load these **trusted, operator-owned** files only in a private operator shell when checking all services together:

```bash
set -a
. /etc/classicfin/web.env
. /etc/classicfin/worker.env
. /etc/classicfin/notifications.env
set +a
npm run production:check -- --config-only
```

The configuration check makes no connection and does not prove live readiness. It prints check names and outcomes without secret values. Do not print the environment or use unredacted `docker compose config` in shared logs.

## 3. Verify and build one immutable artifact in staging/CI

Use the committed lockfile and a supported Node22+ runtime. The integration gate is destructive **only to guarded disposable local scratch databases**; never run it with production database credentials.

```bash
npm ci --ignore-scripts
NODE_ENV=test npm run release:gate
docker build -f deploy/Dockerfile -t YOUR_REGISTRY/classicfin:1.24.0 .
```

Build in CI/staging with a current patched Node22 image. Record source commit, dependency audit, build base-image identity, final image digest and test results. Push the tested artifact to your private registry and record its real immutable `repository@sha256:...` value. Do not build on the production host or deploy `latest`. If the build host uses an HTTPS inspection proxy, provide its CA securely through BuildKit; never disable certificate validation or bake session credentials into layers.

Run browser checks against that exact image with disposable representative tenants: owner/admin/operator/MFA, plan publication/tenant creation, branch views, wallet setup/funding, daily transactions and independent reviews, reports/CSV, privacy and SMS duplicate/revoke behavior. Record target capacity and actual latency under load; local smoke checks do not establish production capacity.

In a managed cloud build that intercepts HTTPS, pass the provided CA only as an optional BuildKit secret: `docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -f deploy/Dockerfile -t YOUR_REGISTRY/classicfin:1.24.0 .`. The Dockerfile retains TLS verification and does not copy that CA into the image. Normal build hosts can use the standard command above.

## 4. Back up and rehearse recovery before upgrading data

Before indexes or migration, take a full consistent backup of platform **and all tenant databases**. The shipped backup tool supports a self-managed unsharded replica set with `mongodump --oplog`; its source URI must not select one database. It now accepts replica-set seed lists. Atlas/sharded or unsupported topologies need their provider-native verified backup/PITR procedure instead.

On the dedicated backup host, with its protected configuration loaded:

```bash
npm run backup:create
npm run backup:doctor
npm run offsite:upload
npm run offsite:doctor
npm run ops:doctor
npm run ops:test-alert
```

Confirm that the independent on-call receiver actually receives the alert and detects missing backup heartbeats. Verify Object Lock/versioning/checksums/retention against the real offsite service; the local receipt alone is insufficient. Daily snapshots can lose almost 24 hours of activity. Set and test a suitable RPO/RTO; add provider-native PITR where the business requires it.

Restore an offsite copy into the isolated `rs-restore` fixture on loopback 27019 using `deploy/compose.restore-rehearsal.yml`, never a production target:

```bash
npm run backup:verify -- /absolute/path/to/actual-full-archive.cfhb
npm run backup:rehearse -- /absolute/path/to/actual-full-archive.cfhb
```

The helper checks the documented baseline platform database `classicfin_platform_db`, tenant mappings and identity uniqueness. If your platform database has another name, use a reviewed restore verification procedure for that name. Independently validate all current Treasury/funding/customer ledger indexes, balances, audit counts and recent references on the restored copy before accepting the drill. Keep restored email/SMS/provider credentials disabled. Record restore time, backup time, data counts, RPO/RTO and key-custody verification. Preserve the encrypted source archive and evidence; never restore over a healthy live database as an application rollback shortcut.

## 5. Apply idempotent indexes and reviewed migrations

Stop financial input during an upgrade that changes storage contracts. With the exact tested image and the real web environment, run `npm run indexes`; it provisions all current unique platform and tenant indexes, including Treasury funding. Run any explicitly required migration for the existing release history only after testing it against a restored staging copy. Do not reset, seed or replace live data with the uploaded archive or development fixtures.

The shipped `release.sh` does **not** automatically migrate a database. It can roll application images back only when those migrations remain compatible with the previous image. Record that compatibility decision and verified backup before running it.

For a fresh installation only, use `npm run bootstrap` with its protected password-file procedure, enroll administrator MFA, publish plans, and test tenant activation. Do not bootstrap/reset credentials during a normal upgrade. Existing manual balances require real independently reviewed opening evidence; no migration invents wallet funds.

## 6. Activate the tested digest

Set deployment selectors in the private operator shell:

```bash
export CLASSICFIN_COMPOSE_FILE=/srv/classic/apps/classicfin/deploy/compose.prod.yml
export CLASSICFIN_STATE_DIR=/srv/classic/compose/classicfin
export CLASSICFIN_ENV_FILE=/etc/classicfin/web.env
export CLASSICFIN_WORKER_ENV_FILE=/etc/classicfin/worker.env
export CLASSICFIN_NOTIFICATION_ENV_FILE=/etc/classicfin/notifications.env
export CLASSICFIN_HOST_PORT=3500
export CLASSICFIN_RELEASE_IMAGE='YOUR_REAL_REGISTRY/classicfin@sha256:YOUR_REAL_64_HEX_DIGEST'
bash deploy/release.sh
```

Replace the digest placeholder. For the first installation only, when no previous digest exists, explicitly set `CLASSICFIN_INITIAL_DEPLOY=I_ACCEPT_NO_AUTOMATIC_ROLLBACK`. There is no automatic application rollback target on a first deployment. Keep the site closed until its smoke checks pass.

The script serializes concurrent releases, validates Compose and pulls the artifact before touching the running services. It activates the same digest for web and both workers. Success requires web readiness and a recent heartbeat from each correct worker class. On activation/readiness failure it restores the saved prior digest and checks it. A pull/configuration failure leaves the existing deployment untouched. It never rolls back a database or restores a backup.

## 7. Run live read-only probes and actual user smoke

With the real three service environments loaded as above:

```bash
npm run production:check -- --live
npm run infra:doctor
npm run ledger:doctor
npm run financial:doctor
npm run worker:doctor
npm run notification:doctor
```

`production:check` reads the configured database primary/authenticated principals, worker-class heartbeats and outbox backlog, checks all services observe the same replica set, and makes bounded HTTPS GETs to the deployed readiness/home/crawler/private routes. It does not send email/SMS, create records, change indexes or process financial operations. Nonzero exit blocks the automated check. A passing report still lists manual evidence and explicitly does not certify production.

On the actual HTTPS domain verify secure cookies, MFA and role restrictions; real email recovery delivery; published landing-page escaping; canonical/robots/sitemap/AI-guide access; private noindex/no-store responses; and mobile/desktop flows. Test a documented low-impact manual transaction with its authorized operator/reviewer and reconcile the actual source balances; do not claim provider execution. Enroll the Android gateway using its private credentials and a supported anonymized message, test deduplication and revocation, and retain its manual fallback. Verify that notifications reach the intended inbox and that dead letters alert.

For transfer SMS, use an authorized controlled receiver number and real provider
configuration. Post a reviewed collection, confirm the encrypted queue's provider
acceptance and actual handset receipt, then check the new PIN with the sender
phone and complete the independent same-branch payout procedure. Verify a retry
does not create another financial posting. Investigate uncertain provider outcomes
before retrying a message. Keep SMS providers disabled on restored/rehearsal data.

## 8. Operate and roll back

Install and validate the shipped systemd backup, backup-health, approval/transfer/banking/forex expiry timers on the actual host. Configure external alerts for web readiness, both worker classes, overdue/dead-letter queues, database elections/storage, backup freshness and missing independent heartbeats. Save a private launch record with domain, digest, prior digest, backup object/version, migration compatibility, smoke outcomes and named operator/on-call contact.

For an application regression with a compatible database, set `CLASSICFIN_RELEASE_IMAGE` to the verified prior digest and rerun `release.sh`. Stop new financial input if data integrity is uncertain. Compare committed source references and audits before retrying any transaction. For database loss/corruption, use the separately approved isolated recovery/PITR and cutover procedure; application image rollback cannot undo posted records.

A launch is accepted only after the real host evidence is complete. Repository tests, a published Git commit, or a passing liveness response alone do not establish that state.
