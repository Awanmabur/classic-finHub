# ClassicFin Hub — Windows startup and dependency security

**9 November 2026.** This project deliberately requires MongoDB replica-set transactions. Do not remove that check or set `REAL_MONEY_ENABLED=true`.

## Recover an update blocked by local files

If `git pull` reports **Your local changes would be overwritten** or **untracked
working tree files would be overwritten**, Git aborts the update. A later
`npm run dev` still starts the old files, even when the download from GitHub
succeeded. This commonly occurs in older copies that tracked `.env` and
`node_modules`, or when updated source files were copied over an old Git checkout.

Stop the watcher with **Ctrl+C**. From the existing `classic-finHub` folder in Git
Bash, create a fresh checkout beside it and carry over the existing private
configuration and retained development MFA key:

```bash
cd ..
updated_dir="classic-finHub-current-$(date +%Y%m%d-%H%M%S)"
git clone --branch master https://github.com/Awanmabur/classic-finHub.git "$updated_dir" &&
cp "classic-finHub/.env" "$updated_dir/.env" &&
{ if [ -f "classic-finHub/.classicfin-dev-mfa.key" ]; then cp "classic-finHub/.classicfin-dev-mfa.key" "$updated_dir/.classicfin-dev-mfa.key"; fi; } &&
cd "$updated_dir" &&
npm ci &&
npm run dev
```

The original folder retains every local change, ignored file and dependency.
Use the new checkout for subsequent work. Existing MongoDB settings and MFA keys
are preserved; compare any separate application changes with the original folder
before bringing them into the updated source. Keep private configuration and keys
outside commits. The current repository ignores `.env` and `node_modules`.

For Atlas, use only `PLATFORM_DB_URI` (with the platform database path) and optional
`MONGO_URI_BASE` (empty database path) in the web `.env`. Remove the older
`MONGO_PLATFORM_URI` entry. Matching SRV pairs can omit `authSource` from both
URLs. `npm run dev` uses these Atlas settings. `npm run dev:local` deliberately
selects the separate loopback development database instead.

## Choose one MongoDB setup

### Defer authenticator setup while configuring the application

Set this in the web `.env` and restart `npm run dev`:

```dotenv
MFA_ENABLED=false
```

Platform Super Admin and tenant accounts can then sign in using email and
password. Role, account status, tenant/branch restrictions and CSRF protections
still apply. Keep the existing `MFA_ENCRYPTION_KEY` and retained development key:
the switch does not delete enrollment, and other encrypted features use that key.

When ready, set `MFA_ENABLED=true`, restart, and sign in again. Existing enrolled
accounts require their authenticator; unenrolled privileged accounts enter setup.
Sessions created without MFA cannot satisfy the re-enabled requirement. If the
variable is absent, MFA enforcement defaults to enabled.

### Tenant creation feedback and interrupted responses

The platform creates each tenant database's indexes before publishing its tenant
record and owner invitation. If Atlas denies this setup, the form now preserves
your entries and explains the required tenant-database permission. Connectivity
and index conflicts also stay visible on the form, with a retry path after the
underlying problem is corrected.

If the response was interrupted, check **Tenants** before submitting again. Open
the existing tenant profile and, while its owner is still pending, use **Create
replacement owner activation link** with a reason. Earlier unused links expire;
the existing tenant is retained. Activated accounts use normal account recovery.

### A. Recommended: isolated development database (Docker Desktop)

Install Docker Desktop for Windows and start it. This workflow neither alters nor deletes the existing Windows MongoDB service. Docker maps the new development database on **127.0.0.1:27018** only and retains its local volume when stopped.

From your project folder in Git Bash:

```bash
npm ci
npm run db:dev:up
npm run dev:local
```

- `db:dev:up` starts MongoDB 8.0 and safely initializes `rs0` once; running it again is idempotent.
- `dev:local` starts it if needed and launches Node's watcher with the local database URI. It selects `PLATFORM_DB_URI` and clears inherited remote/base aliases for this development child process only; the `.env` file is preserved.
- `db:dev:status` displays the container's status.
- `db:dev:down` stops the database, **without removing your data volume**.
- Do not use this unauthenticated development database for real accounts, real customer information or internet-accessible production.
- If Docker's port 27018 is already occupied, resolve the conflict; do **not** disable the replica-set check.

For `npm run dev` (without automatic Docker setup), configure `.env` as follows:

```dotenv
NODE_ENV=development
APP_URL=http://localhost:3000
PLATFORM_DB_URI=mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true
```

Then run `npm run db:doctor`, `npm run db:integration`, and `npm run dev`. The integration probe uses disposable, random scratch databases and refuses remote MongoDB hosts or production mode.

### B. Existing native Windows MongoDB service

Only use this if you own the MongoDB installation and understand the impact on any other apps using it. **Back up the current data before changing its configuration.** In an elevated PowerShell session, find the actual service/configuration path:

```powershell
Get-CimInstance Win32_Service | Where-Object { $_.Name -like '*Mongo*' } | Select-Object Name, PathName
```

Locate the configuration file referenced by the service and set the following section (preserve the rest of the configuration):

```yaml
replication:
  replSetName: rs0
```

Restart the relevant MongoDB service using its actual service name, for example (only if that is the correct service):

```powershell
Restart-Service -Name MongoDB
```

Then **once** from Git Bash or PowerShell, after the server is ready:

```bash
mongosh "mongodb://127.0.0.1:27017/admin?directConnection=true" --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
```

If it is already initialized, do not call `rs.initiate` again. Inspect `rs.status()` instead. Set your project `.env` to:

```dotenv
PLATFORM_DB_URI=mongodb://127.0.0.1:27017/classicfin_platform_db?replicaSet=rs0&directConnection=true
```

Run `npm run db:doctor`, `npm run db:integration`, then `npm run dev`. The integration probe uses disposable, random scratch databases and refuses remote MongoDB hosts or production mode. For a native deployment with authentication, keep your existing credentials, roles, TLS and related settings; the example URI above is for local development only. Official conversion steps: https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/.

## Unified login rollout

After configuring `.env`, run `npm run indexes`, `npm run auth:migrate` to inspect all existing account emails, and `npm run auth:migrate -- --apply` to create the global identity directory. Duplicate emails are deliberately blocked. Only one email/password pair is required at `/signin`, and the backend chooses the platform or tenant dashboard. See [the dedicated migration guide](UNIFIED_AUTH_RELEASE.md). Test full login and password-rotation flows with `npm run auth:integration` on localhost; do not run it against a production cluster.

## Dependencies after an update

Run `npm ci` from the updated checkout before restarting. This installs the reviewed lockfile, including new required libraries. A running old server must be restarted; reloading the browser does not reload its server modules.

`npm run deps:repair` now performs a frozen `npm ci --ignore-scripts --strict-ssl=true` followed by `npm audit --audit-level=moderate`. It does not update Morgan, change the package files, run `npm audit fix`, or choose new dependency versions. The current release gate verifies the dependency advisory status. If an advisory appears later, review an intentional upgrade and test it before changing the lockfile.

## Sign-in after an update

- Keep the existing authenticator encryption key. A changed or missing key cannot unlock enrolled MFA accounts; do not reset accounts or regenerate a key to bypass this.
- `npm run dev:local` loads `.env` before choosing its key. An explicit process value has priority, then `.env`, then its retained private development key. Preserve `.classicfin-dev-mfa.key` if that was the key used for enrollment.
- Plain `npm start` / `npm run dev` in development reuses an existing private retained key only when no key is configured. It never creates or overwrites one. Production never uses this fallback.
- Missing or mismatched MFA keys now produce a specific sign-in setup/recovery message. Restore the original configured key and restart. If it is irretrievably lost, follow the separately authorized MFA recovery procedure; an application update does not authorize a reset.
- Imported audit/subscription records with missing or invalid dates display **Unknown date**. Invalid entitlements remain blocked and lead to the billing explanation; they are not extended by this display fix.
- Unexpected failures show a request reference. Find that reference in the server log to see the safe error code/type and application source location. Do not post complete environment files, keys, database URIs or customer records when reporting an error.

## Important verification boundaries

- The included unit/HTTP suite runs without MongoDB. Passing it does not prove MongoDB transactions work on your Windows machine.
- `db:doctor` verifies that the connection points to a writable replica-set PRIMARY. `db:integration` additionally tests transactional commit, rollback, uniqueness and isolated scratch databases on localhost. Neither verifies backups, access-control policies or payment-provider credentials.
- The Mobile Money module records **unverified** transactions only; no settlement, bank/float balance or payout may be represented as completed.
- For production use authenticated and encrypted MongoDB, isolated credentials, multi-node availability/backup strategy, independent security tests and reconciliation controls.
