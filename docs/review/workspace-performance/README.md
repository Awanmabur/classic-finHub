# Workspace performance and branch administration — 1.28.0

Focused verification on 9 November 2026 (Africa/Kampala) uses disposable loopback MongoDB replica-set databases. It does not measure the user's Windows/Atlas network or certify production capacity.

The workspace now saves visited pages without automatically fetching its entire sidebar and transaction forms after every navigation. Broader preparation is explicit under **Pending sync → Offline availability → Save workspace pages**. Foreground interaction stops that preparation. Unsynced entries retain their original references and encrypted device storage; updating does not require clearing site data.

Tenant setup sends one native index command per ordinary collection while preserving the declared options. The local comparison reduced **104 index commands to 25 for 25 core collections**, verified exact resulting index specifications and confirmed that duplicate email remains rejected. Failed setup is still retryable and cannot publish an incomplete tenant. Fresh branch checks remain request-scoped; there is no cross-request authorization or funds cache.

The storage probe confirms bounded pool checkout rather than waiting behind a slow operation. Ten unchanged session reads/touches produced only the initial session write; explicit session saves and logout remained immediate. The session expiry index is awaited before HTTP startup. The production defaults are separate limits: 7 seconds for server selection/connection, 5 seconds for pool checkout and 30 seconds for inactive sockets. They are not a whole-operation deadline, and no application mutation is automatically replayed.

The compact branch page passed actual database-backed create, edit, archive, restore and operating-location changes in Chromium at **1440, 390 and 320 px**. The checks cover immutable default currency, assigned-staff archive rejection, retained input after a network interruption, modal focus/Escape behavior and Branch Manager read-only scope. Twelve focused branch/template tests passed. The browser run found no overflow, duplicate IDs, script exceptions or missing assets.

Reproduce the checks from the repository root:

```bash
npm run storage:integration
npm run index-batching:integration
npm run mfa-startup:integration
npm run branches:browser
npm run offline:browser
```

The first three run within the local release gate. The browser checks need optional Playwright tooling, Chromium and the unauthenticated loopback replica set on port 27018. They create and remove random fixture databases. `BROWSER_REVIEW_DIR` selects browser output; generated results include the responsive measurements and screenshots. Never run isolated integration probes against live data.

Startup now reports the effective version, MFA mode and configuration source in `app.ready`. An absent/blank flag disables MFA outside production, while production defaults to enabled. Explicit `false` defers enrollment; explicit `true` or invalid nonempty input enables it. Password-only sessions cannot satisfy enforcement after it is re-enabled. Existing keys and enrollments are preserved. See the [Windows setup guide](../../WINDOWS_STARTUP_AND_SECURITY.md#defer-authenticator-setup-while-configuring-the-application) when an exported setting overrides `.env`.

Real deployment acceptance still requires Atlas role/network checks, provider delivery, HTTPS/cookies, representative load and backup recovery. Use the [launch runbook](../../LAUNCH_RUNBOOK.md).

The complete local release gate passed: **505 JavaScript tests**, **13 Android relay tests**, **540 JS/EJS checks**, every registered integration and the online dependency audit (zero vulnerabilities). The same 505 unit tests also passed with `MFA_ENABLED=false`. The MFA startup integration launches real server processes with missing, blank, mixed-case and conflicting environment settings; explicit process configuration retains precedence over `.env`.

The watched-server onboarding browser probe signed in both the platform administrator and newly activated tenant owner with MFA disabled and no enrollment key. It published the empty catalog, created a tenant in **968 ms** on loopback, renewed its subscription and replaced/accepted its invitation. The server remained alive with **one boot**; this local timing does not predict Atlas latency. See [onboarding results](onboarding-browser.json).

The offline browser probe began under an obsolete controlling worker with the old runtime cached. The current runtime loaded on the first navigation, and two visited pages caused **zero extra account-context requests and zero automatic preparation requests**. Only clicking the explicit preparation button initiated its 99 candidate requests. A new online transfer completed while an older draft POST was held; the three offline drafts and two online/outage entries each produced exactly one accepted record. Encryption, unchanged workspace/modal structure, desktop/phone layout and cross-tab logout protections passed. See [offline results](offline-browser.json). The worker also retains offline public assets across version changes without adding private pages or POSTs to CacheStorage.

The production Node **22.23.4** image built from the lockfile and started as UID **1000** with a read-only filesystem, dropped capabilities and no new privileges. Readiness/public/assets returned 200; protected pages redirected to sign-in with no-store/noindex. It reported version 1.28.0 and explicitly disabled MFA. The canonical-host guard rejected unrecognized hosts as expected. No live provider messages were sent.

[Desktop branch directory](branches-1440.png) · [Phone branch directory](branches-390.png) · [Branch operation results](branches-browser.json)
