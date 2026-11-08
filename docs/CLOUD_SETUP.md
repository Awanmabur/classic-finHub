# Cloud development setup

The current environment uses Node.js 24.22.1 (the project requires 22+) and the
repository's loopback-only MongoDB 8 replica set on port 27018. The tested cloud
install script and startup instructions are saved in the environment configuration
draft. Review and publish that configuration to retain the prepared snapshot for
future tasks. Saving a draft does not publish or deploy the application.

Use the existing `/workspace/classic-finHub` checkout; cloud tasks are already
isolated. Do not create another Git worktree unless requested. Source files,
dependencies, database files and private development keys can be retained, but
running processes must be restarted after restoration.

## Start the prepared instance

From the checkout, start the development database:

```bash
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH npm run db:dev:up
```

In each of four separate service sessions, load the prepared development
settings, then start the relevant process:

```bash
cd /workspace/classic-finHub
. /workspace/.classicfin-local/environment.sh
npm start
# Separate sessions, with the same settings:
# npm run worker
# npm run worker:notifications
# npm run worker:tenant-backups
```

The generated private session and MFA keys live outside the checkout in
`/workspace/.classicfin-local`. Do not print them, commit them, or replace an
existing MFA key. The existing local `.env` was preserved, removed from Git
tracking, and is overridden by these explicit development settings. Production
requires separate secrets, authenticated MongoDB and least-privilege worker users;
these local settings must not be reused for production.

Require `/health/ready` to return HTTP 200 and `{"status":"ready"}`, and verify
the public home and sign-in pages return their expected content. Run
`npm run worker:ready` and `node scripts/notification-worker-heartbeat.js` to check
fresh background-worker heartbeats. No user-facing localhost preview is provided
by the onboarding workflow.

## Initialize a new local database

After loading the prepared settings:

```bash
npm run indexes
npm run catalog:publish -- --apply
```

Both commands were exercised repeatedly. They do not create a default login.
For a database without published plans, a signed-in Super Admin can also open
Create Tenant or Plans & Pricing and click **Set up plans and continue**. This
CSRF-protected action publishes the standard immutable catalogue and returns to
the tenant form; it does not create a tenant or alter existing subscriptions.
The first administrator must be explicitly bootstrapped using a user-selected
email and a protected password file, following the README. Never put an initial
password into Git or chat, and do not bypass MFA. Tenant creation then provides
a private, single-use owner activation link.

The Compose configuration preserves its named database volume and sets a 16384
open-file limit, matching this cloud host's hard ceiling. MongoDB 8 also needs the
development file-handle settings in Compose: its default 600-second idle retention
can exhaust even that limit during repeated scratch database/index runs. The
supported startup parameters use a 5-second idle time, a 1-second scan interval,
and a minimum of 250 retained handles. These settings apply only to this local
development database; size production descriptor limits for the actual workload.

After changing Compose, run `npm run db:dev:up` to recreate the development
container with the same named volume, then verify `npm run db:doctor`. No database
volume should be removed as a startup repair. For an already-running development
process, the equivalent reversible setting can be applied through
`wiredTigerEngineRuntimeConfig`; the native file-handle parameters themselves are
startup-only. Check the Docker logs for `Too many open files` rather than treating
a healthy automatic restart as proof that the cause is resolved.

## Validate changes

```bash
. /workspace/.classicfin-local/environment.sh
NODE_ENV=test npm run release:gate
npm run perf:smoke
```

The release gate checks actual HTTP/database workflows using disposable scratch
data; integration commands refuse remote or production targets. It also checks
the online dependency audit. The performance smoke measures only local HTTP
responses, not production concurrency or browser Core Web Vitals.

The prepared instance has no live mail/provider credentials. Internal notification
and financial-recording checks passed without claiming external delivery or money
movement. See [the project review](PROJECT_REVIEW.md) for fixed defects, remaining
features and production acceptance work.


## SMS and configurable-plan additions

The normal index/start commands now also initialize PlanDraft, PlanPublicationLock,
SmsDevice and SmsUsage. Existing development MFA encryption keys must be retained:
they also protect SMS credentials and message text through a separate derived key.
The local release gate additionally runs custom-plan, automatic-branch, signed-SMS,
authorization-race and Python relay checks. Python 3 is needed for those relay
checks (it is available in the prepared cloud instance). Live Android installation
happens on the phone, following the relay guide; the cloud snapshot does not grant
SMS permissions to an Android device.


## Local archive worker

The private retained environment helper now enables local tenant business archives, loads a distinct retained backup key, selects `/workspace/.classicfin-local/tenant-backups` and sets the local backup-worker MongoDB URI. After sourcing `/workspace/.classicfin-local/environment.sh`, start `npm run worker:tenant-backups` alongside web, outbox and notification workers; validate `npm run worker:tenant-backups:ready`. Preserve the private helper/key/directory; never print or commit their contents. This enables local encrypted fallback storage, not live Google consent or Atlas/Yoola activation. The revised reusable install/start instructions and Google/Atlas domain/settings requirements are saved as a draft; review/save/publish in environment settings to activate the reusable configuration. For real HTTPS provider probes in this managed runtime, retain its proxy/CA settings and use the supported Node environment proxy option; the production host uses its own network settings.
