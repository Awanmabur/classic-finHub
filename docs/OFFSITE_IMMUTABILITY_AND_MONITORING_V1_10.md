# ClassicFin Hub v1.10 — Offsite WORM backup, monitoring, disaster retrieval

This release builds on v1.9 **without changing any customer dashboard**. It does not turn the platform into a certified money transmitter or replace a provider's point-in-time recovery capability. Real settlement remains blocked. Database/integration testing, offsite upload, independent incident notification, restore rehearsal and rollback need actual environment evidence before operational sign-off.

## Implemented architecture

```text
self-managed, unsharded replica set (ALL platform + tenant DBs)
  -> mongodump --oplog --archive --gzip
  -> encrypted AES-256-GCM .cfhb (0600, local 0700 directory)
  -> local authenticated archive check
  -> AWS S3 bucket (separate account preferred), versioning enabled, Object Lock enabled
  -> PutObject with explicit SHA-256, COMPLIANCE retention, SSE-S3 and account-owner pin
  -> HEAD same version ID; verify length, entire-object SHA-256, AES256, COMPLIANCE retention
  -> atomically write private .json receipt, never override
  -> 4-hour external health check and incident heartbeat, OnFailure alert
  -> independent alert receiver alarms on missing heartbeat
```

**Supported remote**: actual AWS S3 Object Lock, **not** every S3-compatible service. The one-request upload intentionally rejects archives larger than 5 GB rather than silently degrade object checksum assurances. For larger datasets adopt a reviewed multipart protocol with integrity proofs or, preferably, native snapshots/PITR; never split tenant DBs into independent inconsistent backups.

### Before enabling

1. Set up a **separate AWS account**, security contact and billing alarms. Create a private general-purpose S3 bucket with versioning and Object Lock enabled; choose region and retention after legal, financial-record, and privacy retention review. COMPLIANCE retention cannot be shortened until its date. No public access. No cross-account write from application users. Rotate and preserve offsite key escrow separately from the archive.
2. Provision a limited backup IAM principal with only `s3:PutObject`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObjectRetention`, `s3:GetObjectRetention`, `s3:GetBucketObjectLockConfiguration`, `s3:GetBucketVersioning` (and `s3:ListBucketVersions` for recovery inventory, if desired) scoped to the bucket/prefix and required APIs; deny `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:BypassGovernanceRetention`, `s3:PutBucketVersioning`, `s3:PutBucketObjectLockConfiguration`, bucket administration, and IAM administration. Verify with real AWS IAM simulation or scoped role tests. Bucket permissions and KMS key policy depend on your setup. Use server-side AES256 or a dedicated KMS key with tested recovery access.
3. Install AWS CLI v2 and MongoDB Database Tools on a dedicated, patched backup host. Confirm `/usr/bin/node` exists or edit the unit paths to the approved, pinned Node.js executable on that host; `systemd-analyze verify` must pass there. Provision the OS user `classicbackup` with no interactive shell, private `/var/backups/classicfin` (0700), backup encryption key (0600), `/etc/classicfin/backup.env` (0600), `/etc/classicfin/alert.env` (0600), alert token file (0600), and least-privilege database credentials. On Contabo, prefer protected credentials at `/etc/classicfin/aws-credentials` with `AWS_SHARED_CREDENTIALS_FILE=/etc/classicfin/aws-credentials`; don't depend on `~/.aws` because the systemd services use `ProtectHome=yes`. Use a dedicated backup role/profile—not web/worker credentials.
4. Copy the example environment files from `deploy/backup.env.example` and `deploy/alert.env.example`, then fill in `OFFSITE_S3_BUCKET`, `OFFSITE_S3_EXPECTED_OWNER` (12-digit AWS account owner), `OFFSITE_S3_PREFIX`, `AWS_REGION`, `OFFSITE_RETENTION_DAYS` (default 90), `OFFSITE_MAX_AGE_HOURS` (default 26), `OPS_ALERT_URL` (trusted HTTPS JSON incident endpoint, no URL credentials), and `OPS_ALERT_TOKEN_FILE` (bearer token accessible only to backup account). **The alert receiver must accept JSON with `Authorization: Bearer ...`**; a standard Slack incoming webhook is not supported directly.
5. Verify that the dedicated offsite account is **not** the same account as your app deploy/service owner. Do not place backup key, AWS credentials, secret token, or backup receipts in Git, Docker images or public web directories.

### Setup and test (with private environment loaded)

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run backup:create
npm run backup:verify -- /var/backups/classicfin/classicfin-full-ACTUAL.cfhb
npm run offsite:upload
npm run backup:doctor
npm run offsite:doctor
npm run ops:doctor
npm run ops:test-alert
```

`offsite:upload` authenticates the latest ciphertext locally before network upload and requires independent remote object-version, checksum and COMPLIANCE evidence before writing the private receipt. Retries with an existing receipt validate the exact object version instead of uploading again. **If an ambiguous upload succeeded but its receipt was never created, a retry can create a second protected S3 version**; no financial action is replayed, but storage costs can increase. Monitor orphaned versions and never delete them without approval.

`offsite:doctor` independently checks the newest receipt's freshness and performs S3 HEAD for that exact version, object checksum and retention. The receipt is local operational metadata, **not an independent proof** by itself, and should be archived elsewhere to simplify disaster recovery.

After installation review the shipped units, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now classicfin-backup.timer classicfin-backup-health.timer
sudo systemctl start classicfin-backup.service
sudo systemctl start classicfin-backup-health.service
sudo systemctl status classicfin-backup.service classicfin-backup-health.service
sudo journalctl -u classicfin-backup.service -u classicfin-backup-health.service --since '24 hours ago'
```

`classicfin-backup.service` creates the encrypted archive, uploads it, checks local freshness, and verifies the offsite copy. Any failed step prevents successful completion and triggers `classicfin-alert@backup-failure.service`. The four-hour `classicfin-backup-health.timer` checks both locations and sends a small `backup-heartbeat` event on success; failures trigger `classicfin-alert@backup-stale.service`. Configure your *independent* alert receiver to notify an on-call contact on any critical event **and on missing heartbeats for 9 hours**; a dead host cannot send its own failure notification. Ensure systemd failure alert delivery itself is watched (a broken webhook can also fail).

### Disaster recovery from S3 when the backup host is gone

1. With the independently escrowed AES-GCM key and **separate recovery-only AWS credentials**, find the exact `classicfin-full-*.cfhb` key and version ID using `aws s3api list-object-versions --bucket BUCKET --prefix classicfin/` or your retention inventory. Check that the selected object has COMPLIANCE retention, a usable intact SHA-256 checksum, expected owner and full snapshot coverage.
2. On a **different, isolated recovery machine**, create a private directory, for example `install -d -m 700 /var/backups/classicfin-recovery`. Populate `BACKUP_RECOVERY_DIR` and the private backup/environment values. Fetch that version:

```bash
npm run offsite:fetch -- 'classicfin/classicfin-full-EXACT.cfhb' 'EXACT_S3_VERSION_ID'
npm run backup:verify -- /var/backups/classicfin-recovery/classicfin-full-EXACT.cfhb
```

The command refuses an existing destination file, downloads only the specified object version and independently checks ciphertext SHA-256 and AES-256-GCM authentication before publishing it. It never restores directly into MongoDB.

3. Bring up the **disposable isolated** MongoDB `rs-restore` fixture as documented in `docs/DISASTER_RECOVERY_V1_9.md`. Run `backup:rehearse` against the fetched archive (it verifies emptiness, target isolation, oplog replay and required DB/index structures). Validate identities, subscriptions, tenant separation, employee branch permissions, recent transaction references and audit event counts. Do not allow restored apps to send live SMS/email or real payments.
4. Save a signed recovery evidence package (without customer data or credentials): AWS object/version ID, original dump time, local encryption check, restore time, per-DB counts, critical schema/integrity findings, observed RTO/RPO, key custody, and two-authorizer signoff. Destroy the scratch DB only after preserving evidence.

**Current recovery limit:** These are *daily full snapshots*, **not point-in-time recovery**. RPO may approach 24 hours even if remote uploads succeed, which is unacceptable for actual settlement without provider reconciliation/replay and PITR. The target MongoDB collection/identity controls should also pass integration tests on a live isolated replica set. No live AWS, alert receiver, backup restore, Contabo deployment or external third-party penetration test has been run as part of this artifact build.

### Controls that must be operated externally

- AWS billing alarms, blocked public access, bucket/Object Lock policy and key escrow; separate incident-contact accounts and access review.
- Real post-deployment TLS/SEO/AI-crawler verification and browser/Core Web Vitals; local smoke results are not production results.
- Incident receiver with on-call escalation, test alert acknowledgment and 9-hour dead-man heartbeat check.
- Retention schedule and an approved deletion process after applicable legal periods; Object Lock retention itself must be selected before uploading sensitive data.
- Successful **restore from the offsite copy** and a measured RTO/RPO, including corrupt-archive and primary-election exercises; weekly/monthly drill cadence by risk.
- Connected-provider settlement reconciliation and the balanced ledger, still blocked in this release.
