# ClassicFin Hub v1.9: Encrypted backups, restore rehearsal and immutable release

## Boundary and architecture

The platform is one Node.js/Express modular monolith using a MongoDB replica set with a shared bounded connection pool and separately named tenant databases. A *platform-database-only* dump would **not** protect tenant transactions, permissions or audit records. The full `mongodump --oplog --archive --gzip` workflow must include **every** database in the replica set. It is designed for a self-managed **unsharded** MongoDB replica set. For a sharded cluster, managed Atlas deployment or larger production cluster, use provider-native coordinated snapshots / PITR instead of assuming this script is sufficient.

The backup runner is separate from the application and uses a dedicated credential. The private `mongodump --config` file is 0600 and deleted immediately afterward, so MongoDB credentials do not appear in process arguments. The compressed BSON archive is streamed through AES-256-GCM, protected by a 32-byte backup key stored in a private file. The output file is `.cfhb` with an authenticated tag; plaintext is never written to the host backup directory. Partial backups are removed. The operator must independently manage the encryption key, offsite replication, retention, alerting, and restore rehearsals.

This release does **not** provide continuous point-in-time recovery. Nightly full backups can lose up to a day's data: that is unsuitable for actual financial settlement. Define acceptable RPO/RTO and add continuous oplog or provider-managed PITR and multi-region copies *before enabling real money*. Encryption without offsite key escrow can make every backup unrecoverable.

## Install on the production backup host

1. Install a supported Node.js runtime and MongoDB Database Tools (100.3.0+ for `--config`) on the backup host. Keep these tools patched.
2. Provision a least-privilege `classicbackup` operating-system account, an owner-only backup directory (`/var/backups/classicfin`, mode 0700), and a separately protected key file (`/etc/classicfin/backup-key`, 0600). Do not share the web application's session or MFA secrets with this account.
3. Generate a new key once: `openssl rand -hex 32` in a controlled terminal, and store it in the private file. **Do not regenerate the key after backups are made** unless all existing archives are rekeyed with a verified process. Safeguard a separate offsite key copy.
4. Create `/etc/classicfin/backup.env` with mode 0600 based on `deploy/backup.env.example`; `BACKUP_SOURCE_URI` must be a full replica-set URI **without a database path**. Do not use `MONGO_PLATFORM_URI`, which selects one database.
5. Run `npm run backup:create` from the project root under `classicbackup`; it fails if a valid dump cannot be generated and authenticated. Run `npm run backup:doctor` and verify the exit code.
6. After reviewing paths, install `deploy/systemd/classicfin-backup.service` and `.timer`, then `systemctl daemon-reload && systemctl enable --now classicfin-backup.timer`. The timer runs daily at 01:00 UTC with up to 10 minutes of jitter. Attach an **external incident alert** to backup job failure and to the freshness diagnostic (a failed timer must not silently remain unnoticed).
7. Replicate *only encrypted* `.cfhb` archives to a separate account/provider, using immutable retention/object lock. Keep independent copies and periodically test recovery from the offsite copy. Monitor free disk space, key accessibility, failure alerts and successful snapshots. Do not copy secrets or plaintext archives to Git, the container image, or object storage.

### Manual commands

```bash
npm run backup:create
npm run backup:doctor
npm run backup:verify -- /var/backups/classicfin/classicfin-full-REPLACE.cfhb
```

`backup:doctor` checks the newest archive's age and authenticates its AES-GCM tag; it does **not** prove all database documents, indexes, or application workflows can be restored. Only a full restore rehearsal proves this.

## Destructive restore rehearsal — disposable instance ONLY

1. Choose a host with disk/RAM capacity for the entire restored replica set. **Do not use production or the application development MongoDB.** The rehearsal command fails closed unless the destination is loopback `:27019`, replica set `rs-restore`, is writable, and contains no non-system databases.
2. Start the dedicated disposable restore container:

```bash
docker compose -f deploy/compose.restore-rehearsal.yml up -d
docker compose -f deploy/compose.restore-rehearsal.yml exec restore-mongo \
  mongosh --quiet --eval 'rs.initiate({_id:"rs-restore",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

3. Set `BACKUP_RESTORE_URI=mongodb://127.0.0.1:27019/admin?replicaSet=rs-restore&directConnection=true`, then:

```bash
npm run backup:verify -- /absolute/archive.cfhb
npm run backup:rehearse -- /absolute/archive.cfhb
```

The backup is authenticated **before** writing to the scratch database, then restored with oplog replay. Read the restored data in a *separate* authorized verification session: ensure expected platform and tenant databases exist, customer and permission records are consistent, critical unique indexes are present, and the application integration/financial invariants pass against the restored copy. Never allow the restored web app to send real SMS, email, or payments; revoke or replace copied secrets and integration endpoints.

4. Record an evidence report: archive ID, timestamp, offsite copy, tool versions, restore duration, collection counts, identity and tenant checks, test results, RPO and RTO, incident signoff. Only then destroy the disposable database (`docker compose -f deploy/compose.restore-rehearsal.yml down`). This workflow does not run autonomously in CI or production.

**IMPORTANT:** The restore-only container is isolated by an internal Docker network and loopback port binding. This is one protection, not a substitute for network firewall policy. Do not tunnel this port to production.

## Immutable release and rollback

The production Compose configuration no longer builds a mutable image on the host. A *single digest-pinned image* is required for both web and background worker. Build once in trusted CI, sign/scan as appropriate, push to the registry, and test that digest on staging. Before any release, verify backward-compatible database/schema changes, test database backups and restore, validate secrets and tenant access, and confirm the original version remains available.

```bash
export CLASSICFIN_COMPOSE_FILE=/srv/classic/apps/classicfin/deploy/compose.prod.yml
export CLASSICFIN_ENV_FILE=/srv/classic/secrets/classicfin.env
export CLASSICFIN_WORKER_ENV_FILE=/srv/classic/secrets/classicfin-worker.env
export CLASSICFIN_STATE_DIR=/srv/classic/compose/classicfin
export CLASSICFIN_HOST_PORT=3500
export CLASSICFIN_RELEASE_IMAGE='registry.example/classicfin-hub@sha256:REPLACE_WITH_REAL_64_HEX_DIGEST'
bash deploy/release.sh
```

The release script runs Compose interpolation checks, pulls the exact digest, updates both services, checks web `/health/ready` **and** worker database heartbeat, then stores the active immutable image. If the check fails, it reverts both services to the prior saved digest. For an initial deployment without a stored previous digest, explicitly set `CLASSICFIN_INITIAL_DEPLOY=I_ACCEPT_NO_AUTOMATIC_ROLLBACK`; an initial release has no automated rollback target.

Do not use this script to introduce a **destructive database migration**: image rollback cannot reverse altered historical data or changed schema. Migrations must be backward compatible with the previous deployed image, or use a separately reviewed restore/forward-fix plan. The release script is a deployment mechanism, not proof of PCI, privacy, financial regulatory or penetration-test compliance.

## Operational and security gates

- Validate `npm audit --audit-level=moderate` in CI and on a registry-connected environment. Do not accept the offline result as security clearance.
- Verify backup creation, **actual MongoDB restore**, data consistency and key recovery; test the offsite copy; alert on failed jobs and old backups.
- Exercise a failed rolling release and verify rollback health checks; keep the previous digest available in the registry.
- Test network partitions, MongoDB primary elections, disk-full behavior, worker recovery and alert notification.
- Review access to web/worker/backup credentials separately and rotate compromised secrets with documented procedure.
- Complete production load/soak testing, TLS/WAF/logging, independent pentest, disaster recovery drill, privacy retention, and payment provider reconciliation before financial enablement.

## Checks executed in the artifact build environment

Unit tests cover AES-GCM tampering, password/key mismatch, a failed dump, partial-file cleanup, source/target safety guards, stream decryption into a simulated restore executable, and backup freshness. **No real `mongodump`, `mongorestore`, Docker daemon, offsite backup provider, payment provider, or production MongoDB was available for live validation.** These remain mandatory release gates.
