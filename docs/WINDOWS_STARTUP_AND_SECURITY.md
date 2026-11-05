# ClassicFin Hub — Windows startup and dependency security

**November 3, 2026.** This project deliberately requires MongoDB replica-set transactions. Do not remove that check or set `REAL_MONEY_ENABLED=true`.

## Choose one MongoDB setup

### A. Recommended: isolated development database (Docker Desktop)

Install Docker Desktop for Windows and start it. This workflow neither alters nor deletes the existing Windows MongoDB service. Docker maps the new development database on **127.0.0.1:27018** only and retains its local volume when stopped.

From your project folder in Git Bash:

```bash
npm ci
npm run db:dev:up
npm run dev:local
```

- `db:dev:up` starts MongoDB 8.0 and safely initializes `rs0` once; running it again is idempotent.
- `dev:local` starts it if needed and launches your existing nodemon server with the correct database URI. It overrides `MONGO_PLATFORM_URI` for this development process only.
- `db:dev:status` displays the container's status.
- `db:dev:down` stops the database, **without removing your data volume**.
- Do not use this unauthenticated development database for real accounts, real customer information or internet-accessible production.
- If Docker's port 27018 is already occupied, resolve the conflict; do **not** disable the replica-set check.

For `npm run dev` (without automatic Docker setup), configure `.env` as follows:

```dotenv
NODE_ENV=development
APP_URL=http://localhost:3000
MONGO_PLATFORM_URI=mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true
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
MONGO_PLATFORM_URI=mongodb://127.0.0.1:27017/classicfin_platform_db?replicaSet=rs0&directConnection=true
```

Run `npm run db:doctor`, `npm run db:integration`, then `npm run dev`. The integration probe uses disposable, random scratch databases and refuses remote MongoDB hosts or production mode. For a native deployment with authentication, keep your existing credentials, roles, TLS and related settings; the example URI above is for local development only. Official conversion steps: https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/.

## Unified login rollout

After configuring `.env`, run `npm run indexes`, `npm run auth:migrate` to inspect all existing account emails, and `npm run auth:migrate -- --apply` to create the global identity directory. Duplicate emails are deliberately blocked. Only one email/password pair is required at `/signin`, and the backend chooses the platform or tenant dashboard. See [the dedicated migration guide](UNIFIED_AUTH_RELEASE.md). Test full login and password-rotation flows with `npm run auth:integration` on localhost; do not run it against a production cluster.

## Dependency vulnerabilities

Your source archive's lockfile contains older dependencies. Your terminal reported **12 advisories (7 moderate, 4 high, 1 critical)** on November 3, 2026, but the names and exact fixes were not included in that short summary. This environment could not access the npm security registry, so **the 12 advisories have not been verified as cleared and the original lockfile is retained** rather than creating an invalid or untested lockfile.

With internet access from your Windows computer, run:

```bash
npm run deps:repair
```

The script runs a reviewed, same-major `morgan` update, then `npm audit fix` without `--force`; it regenerates the real npm lockfile, rechecks advisories and exits unsuccessfully if any remain. It intentionally leaves updates requiring manual breaking-change review unresolved. `npm audit fix --force` may change major versions and break EJS or other parts of the application. Do not use it blindly.

After remediation:

```bash
npm audit
npm ci
npm run check
npm test
npm run db:doctor
```

If `deps:repair` still reports issues, inspect them individually with `npm audit` and capture the output of `npm audit --json` for case-by-case upgrades and vulnerability triage. Commit **both** updated package files after checking the changes. The included GitHub Actions security workflow intentionally rejects high/critical advisory counts; **it is not proof that the current lockfile passes that gate**.

## Important verification boundaries

- The included unit/HTTP suite runs without MongoDB. Passing it does not prove MongoDB transactions work on your Windows machine.
- `db:doctor` verifies that the connection points to a writable replica-set PRIMARY. `db:integration` additionally tests transactional commit, rollback, uniqueness and isolated scratch databases on localhost. Neither verifies backups, access-control policies or payment-provider credentials.
- The Mobile Money module records **unverified** transactions only; no settlement, bank/float balance or payout may be represented as completed.
- For production use authenticated and encrypted MongoDB, isolated credentials, multi-node availability/backup strategy, independent security tests and reconciliation controls.
