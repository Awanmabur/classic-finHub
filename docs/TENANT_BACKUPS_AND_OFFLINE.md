# Branch transfers, offline drafts and tenant backups

Implemented in the 1.25.0 candidate. Live Google consent, Atlas access and Yoola delivery require the actual private service settings; local tests use disposable databases and mocked Google responses.

## Branch transfers and phone defaults

- **From branch** is the authenticated teller's operating branch. **To branch** offers active branches in the same tenant. Both branches must support the selected currency. A viewing-branch change cannot move a teller's drawer.
- The sender and receiver are typed names and phone numbers. Countries are no longer destination selectors. New PINs bind the sender phone and selected receiving branch; existing origin-branch PIN versions remain supported.
- Collection requires the existing independent review and actual opened fund accounts. Its encrypted SMS contains the receiving branch. At that branch, check the PIN, sender phone and receiver identity; select the verified payout drawer and obtain a different reviewer's approval. A valid PIN alone does not disburse cash.
- Cross-branch payout commits two balanced journals in the same database transaction: the origin transfer payable becomes an interbranch payable; the destination records an interbranch receivable and decreases its actual cash. These dues remain outstanding until separately reconciled against actual branch settlement. The transfer does not claim that cash was physically transported between offices.
- Phone placeholders and national-number normalization use an explicitly configured, overwriting edge GeoIP header. Otherwise South Sudan (`SS`, `+211`) is used. Explicit international numbers retain their calling code. Set `GEO_COUNTRY_HEADERS_TRUSTED=true`, the actual `TRUST_PROXY` hop count (1 or 2), and `GEO_COUNTRY_HEADER` to `cf-ipcountry`, `cloudfront-viewer-country` or `x-country-code` only when the edge strips client copies. Do not enable this for an unprotected origin. Offline drafts preserve the original country context.

## Offline operation

1. Sign in while connected and visit the operation forms needed on that device in each required currency/network/payment configuration. Those prepared choices stay fixed in each offline template; up to 20 configurations per operation are retained. Use a managed device and browser profile assigned to that operator. Modern HTTPS browsers with WebCrypto, IndexedDB and service workers are required; loopback is allowed for development.
2. The app stores encrypted form templates and drafts, with a non-exportable device key and tenant/user/credential-version binding. It caches a fixed public offline shell, never private dashboard HTML, API results, receipts, balances, CSRF tokens or PIN pages.
3. If connectivity is lost, a supported form saves a **pending draft**. Navigation to a tenant page opens the offline shell. **Offline drafts** in the sidebar footer also opens it. Create another draft from a previously visited form or inspect pending details there.
4. Supported capture routes are Mobile Money cash-in/cash-out, transfer requests, Banking requests, Forex quotes and expenses. PIN checks/payouts, financial reviews, opening balances, funds movements, credential/configuration changes and provider execution require a connection. Offline balances and rates are not live, and the draft never authorizes paying out cash or issuing a final receipt/PIN.
5. Reconnection automatically checks the current session, identity and operating branch, gets a fresh CSRF token, and submits the original guarded route with the original idempotency reference. The server checks current modules, permissions, quotas, balances and rates. Repeated sync cannot create another operation under that reference.
6. **Synced** means the server accepted the request; existing financial verification/review still applies. **Needs attention** retains the draft and the rejection reason. Check server records before discarding or re-entering it, especially after an interrupted submission. Auth/access failures pause syncing. Credential resets or a changed assignment can lock old drafts; resolve them with an administrator instead of changing their identity binding.
7. Signing out locks the local scope. Do not clear site data, uninstall the browser or reset the device while it contains unsynced drafts. Synced local status can be cleared after checking the accepted record. Browser storage eviction or device loss cannot be recovered from the server before a draft syncs.

## Google Drive and platform copies

The Drive icon beside **Last receipt** is available to Tenant Owners and Branch Managers. An Owner's archive contains all tenant branches; a Manager's archive contains only their assigned branch and relevant incoming transfer instructions. Platform administrators do not gain tenant archive access through these endpoints.

- First click starts Google consent when OAuth is configured. The app requests only `https://www.googleapis.com/auth/drive.appdata`; it does not read Gmail or unrelated Drive files. OAuth state is session/user/tenant/version bound, expires after five minutes, and uses PKCE. The refresh token is encrypted with the dedicated archive key.
- After connection, clicking again queues a check. A consistent full business snapshot is hashed; unchanged data yields **No unbacked data** and does not create another archive. The worker detects inserts, updates and deletions. Backup audit and checkpoint metadata are excluded from the business digest.
- A private encrypted platform file is written, synced and authenticated before a checkpoint is saved. The worker uploads it to ClassicFin Hub's private Drive app folder and verifies its remote byte count/checksum. A full, revoked or unreachable Drive keeps the platform copy and retries after 15 minutes. Check the saved-to and failure status; queued is not complete.
- The default schedule is daily at **18:30 Africa/Juba**, thirty minutes after the default 18:00 closing. Owners/Managers can set their scope's closing time and IANA time zone on **Backups**. A late-night closing can schedule after midnight. A tenant-wide policy is initialized by the worker even if no one has clicked Drive; use the tenant profile's time zone when present. Branch policies are created when a Manager opens the backup feature.
- The target retention is the latest 30 snapshots per scope. Old copies that cannot yet be safely removed from Drive are retained for retry; monitor persistent-volume capacity. The worker refuses a new file if free space is too low. The bounded business export supports 200,000 records / 25 MiB of serialized data per snapshot; larger tenants need the existing full replica backup and a scaled export/recovery procedure.
- Password hashes, MFA state, refresh tokens, verification tokens, raw SMS, outbound message bodies and payout PIN material are excluded. The archives contain sensitive customer/business records and must remain encrypted. They supplement the full replica-set offsite/restore procedure, which is still required to restore application authentication and unclaimed PIN state.

## Deployment configuration

Configure these privately in **both web and backup worker**: `TENANT_BACKUPS_ENABLED=true`, a separate random 64-hex `TENANT_BACKUP_ENCRYPTION_KEY`, `TENANT_BACKUP_DIR`, the real HTTPS `APP_URL`, `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET`. The backup key must differ from the MFA and transfer-SMS keys. Preserve it in separate recovery custody; do not rotate it in place without migrating existing tokens/archives.

In Google Cloud, enable Drive API, create a Web OAuth client, configure the consent audience/test users or publish the consent configuration as appropriate, and register exactly:

```text
https://YOUR_REAL_HOST/tenant/backups/google/callback
```

The backup worker additionally uses **its own** `MONGO_BACKUP_WORKER_URI`, naming the same platform database/replica set with TLS. Its database role needs platform Tenant reads and WorkerHeartbeat writes; read access to tenant business collections; and writes/index administration only for the tenant backup policy/archive collections. Provision collection indexes with the migration principal before starting a least-privilege production worker. Do not grant access to platform administrator credentials or arbitrary tenant authentication writes. Read access includes tenant user role/assignment/MFA-enrollment metadata; the worker's queries explicitly exclude authentication payloads.

Run `npm run worker:tenant-backups` independently; verify `npm run worker:tenant-backups:ready`. It needs no HTTP port, web session secret, MFA encryption key or SMS provider credentials. Monitor `tenant_backup.*` events, freshness of confirmed snapshots, `lastResult=error`, Drive failure codes and disk space. A heartbeat alone does not prove that every scope has a recent successful archive.

For Docker, combine `deploy/compose.prod.yml` and `deploy/compose.tenant-backups.yml`. Set private `CLASSICFIN_TENANT_BACKUP_ENV_FILE`, `CLASSICFIN_TENANT_BACKUP_DIR` and `CLASSICFIN_TENANT_BACKUP_COMPOSE_FILE`. Create the host directory with 0700 permissions owned by the tested image's runtime UID/GID (the official Node image uses node/1000). Mount it read-only in web and writable in the backup worker. Set web's `TENANT_BACKUP_DIR=/var/lib/classicfin/tenant-backups`. Keep the same tested immutable image for all services. The release script includes backup health and rollback when the overlay is configured. Keep the directory on durable storage and include its encrypted contents and separate key custody in the offsite recovery procedure.

`npm run production:check` adds backup configuration, Google configuration, TLS URI, distinct database-principal and worker-heartbeat checks when tenant backups are enabled. Actual consent, upload, quota failure and restore evidence are still required on the deployment.

## Verify or recover a business archive

Download the encrypted archive from **Backups**, or obtain its authenticated Drive app-data copy through the authorized application/Google recovery procedure. Restore the separate backup key in a private process environment. Each archive carries a small authenticated public header containing non-secret tenant/scope identifiers and its digest, so recovery does not depend on a surviving policy database. Business records remain encrypted. Filenames contain the policy ID and digest, never credentials.

```bash
node scripts/tenant-archive.js verify --file /private/POLICY-DIGEST.cfhbackup --tenant TENANT_OBJECT_ID --scope tenant
node scripts/tenant-archive.js export-json --file /private/POLICY-DIGEST.cfhbackup --tenant TENANT_OBJECT_ID --scope tenant --output /private/recovery/business.json
```

Use the actual generated filename. New archives infer their tenant/scope from the authenticated header; explicit flags add an independent expected-scope check. Older headerless copies require both flags from recovery records. Branch scope is `branch_BRANCH_OBJECT_ID`. The output directory must be private (0700); export refuses to overwrite a file and writes plaintext JSON as 0600. Verification checks AES-GCM authentication, tenant/scope binding and the complete canonical business digest. It prints only counts/digest metadata. The tool never writes a database. Review any recovery import with ledger/book checks and independent business authorization; use the full replica restore runbook for complete application recovery.

## MongoDB and SMS activation still needed

MongoDB is running and tested locally. For Atlas, supply the actual project/cluster access and private connection settings before remote setup can be verified. `PLATFORM_DB_URI` is accepted as an alias for `MONGO_PLATFORM_URI`; `MONGO_URI_BASE` is optional and must use the same deployment, credential, explicit `authSource`, TLS and options (apart from `appName`). Keep its database path empty. Each tenant has `classicfin_tenant_SLUG_WITH_UNDERSCORES_db` and its own server-derived connection link; the application shares a bounded connection pool and never exposes that credential-bearing link in tenant pages. Redis is not needed by the current application.

Create separate web, outbox, notification and backup service users with scoped roles. Do not put credential-bearing URI examples in documentation/Git. With the private Atlas variables selected, run `npm run db:doctor` first; run indexes/migrations only during the intended deployment procedure. Local integration scripts deliberately refuse production/remote targets.

Yoola was requested as the initial outbound SMS provider. Its official API documentation/endpoint, authentication rules, sender approval and delivery semantics have not been supplied, so no speculative Yoola transport has been activated. The existing encrypted SMS outbox and sender/PIN workflow remain intact; the currently verified transport contract is Twilio. Keep provider execution disabled or use the explicit private manual PIN handoff until Yoola's adapter is implemented and tested on a controlled handset. South Sudan local services should plug into the same provider boundary after their contracts are verified. Android inbound Mobile Money capture is a separate workflow.
