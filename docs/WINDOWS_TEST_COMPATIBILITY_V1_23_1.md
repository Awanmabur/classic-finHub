# ClassicFin Hub v1.23.1 — Windows test compatibility fixes

Patch baseline: **v1.23.0**. Intended for the original v1.23 source; this is not a production certification.

## Corrected issues from the Windows npm test log

- Ten backup/offsite tests: test-only `fake-mongodump`, `broken-mongodump` and `fake-mongorestore` scripts now have `.js` filenames. The backup process runner uses the current Node executable when an **explicit** `.js`/`.cjs` script is passed. Default production `mongodump`/`mongorestore` still launch directly, with `shell: false`, and database credentials remain in private temporary configuration files instead of command-line arguments.
- Cash shift reporting: the test now expects **403** for an invalid *assigned branch*; this is a privilege-boundary violation, not a client-generated financial request validation error. Production behavior is unchanged.
- SEO: the isolated production crawler test now explicitly sets `SEO_INDEXING_ENABLED=true`, overriding a developer's `.env` setting of `false`. The production configuration is unchanged and continues to disallow indexing when the feature is disabled.
- Asynchronous database-tool errors: an immediate promise rejection handler prevents unhandled rejection warnings while callers still receive an error and partial archives are deleted.

## Verification

- `node --test tests/backup-recovery.test.js tests/offsite-backup.test.js`: **16/16 passed** on Linux.
- `node --check` on all changed scripts: **passed**.
- Full suite and EJS runtime checks: **not executed here**; dependencies could not be installed in the execution environment. Offline npm install failed `ENOTCACHED`; online installation failed with npm's `Exit handler never called!`.
- Windows test run: **requires running on the user's Windows machine**; the fixture change is designed to address the recorded executable-start errors.
- Live MongoDB, Stripe/payment gateways, external mail, Redis, S3 and production backup/restore: **not verified**.
- `npm audit` vulnerabilities in the user's log (10: 1 critical, 4 high, 5 moderate): **not fixed**. Must inspect `npm audit --json` and plan non-breaking upgrades, regression tests and production deployment separately.

## Apply from project root, only if your files match v1.23.0

```bash
git status --short
git apply --check classicfin-v1.23.0-to-v1.23.1.patch
git apply classicfin-v1.23.0-to-v1.23.1.patch
npm test
npm audit --audit-level=moderate
```

Your shared Git status includes hundreds of deleted `node_modules` files; these are **not** fixed by this patch. Do not run `git reset --hard` or stage all changes. Audit and untrack dependencies in a separate reviewed Git change if necessary. Take care not to overwrite local project edits; on conflicts, compare and selectively merge the six changed source/configuration files and four test files.
