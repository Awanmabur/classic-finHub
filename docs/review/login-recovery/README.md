# Post-login recovery — 1.25.1

Verified locally on 8 November 2026. The reported running copy was not available through a supplied URL; the cloud database has no user accounts. These are reproduced failure cases and tested fixes, not a claim of remote access to the reported machine.

- `dev:local` previously read its MFA key before loading `.env`, allowing a different retained development key to override the configured enrollment key. It now loads dotenv first and preserves explicit environment precedence.
- Plain development startup reuses an existing private retained key when none is configured. It never creates or changes one; production and tests cannot use that fallback. Symlinks, invalid content and unsafe private-file permissions are rejected.
- Missing or mismatched keys stay denied, return classified 503 errors and explain the required key setup/recovery. Stored enrollment is preserved.
- Missing/invalid audit dates previously crashed the platform dashboard after MFA. Invalid subscription dates could redirect a tenant to a billing page that also crashed. These display `Unknown date`; invalid entitlements still block financial writes. Legacy module arrays do not acquire new permissions.
- Required phone-library loading now happens before accepting logins; stale installations fail during startup instead of on the tenant's first page. Frozen dependency repair installs the reviewed lockfile without adding removed dependencies or changing package versions.
- Invalid phone-country data returns validation errors, and unavailable/corrupt archive files return controlled recovery errors instead of unhandled failures.
- Unexpected errors include a request reference. Server diagnostics contain only fixed error classifications and checked application source locations, with no exception messages, customer values, passwords or URIs.

Validation: **458 tests**, 519 JS/EJS checks, full release gate with 13 relay tests and all isolated Mongo integrations, zero dependency advisories. `npm run login:integration` performs real password/MFA redirects and dashboard requests for platform and tenant accounts, with legacy audit/subscription data and denied wrong-key/expired-entitlement cases. It passed on both the development runtime and the Node 22 production image. Chromium also completed the real sign-in/MFA flow and 12 responsive/offline/archive scenarios without browser or asset errors. All accounts/data were synthetic and disposable; no shared credentials were reset.

After updating an existing installation, run `npm ci` before restarting its server. Preserve the original MFA key. See [startup troubleshooting](../../WINDOWS_STARTUP_AND_SECURITY.md#sign-in-after-an-update). Production deployment/Atlas, Google consent and Yoola activation remain separate configuration work.
