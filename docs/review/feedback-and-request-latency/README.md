# Feedback and request latency — 1.29.0

Verified on 10 November 2026 (Africa/Kampala) using disposable loopback MongoDB replica-set databases and Chromium. These checks do not measure the user’s Windows/Atlas connection or establish production capacity.

Flashes were consumed by invisible GETs following fetch submissions. The browser then navigated to the same destination again, losing the message and repeating its queries. Opt-in same-origin JSON redirects now allow one actual navigation; native forms keep their normal redirects. Success messages remain until a document displays them; background requests cannot consume them. Incorrect sign-in and validation responses show persistent accessible feedback, keep the form editable and release its controls. One-time PIN/invitation HTML and external Google consent keep their dedicated handoffs.

The [feedback browser check](feedback-browser.json) covers visible wrong-password messages, retained email, duplicate-click prevention, correct login, invalid platform profile without a database write, successful profile update with one destination GET and one flash, branch updates, interrupted writes, unconfigured recovery email and activation validation without putting the token back in the URL. All desktop/phone captures have no overflow, browser exceptions or failed assets. [Phone wrong-password view](wrong-password-390.png) and [validation view](validation-390.png).

Financial submissions keep their encrypted draft and original reference through uncertain responses. Foreground submissions reuse only a transient server-issued CSRF context; the POST freshly verifies the bound account version and operating branch before mutation. Background backlog still checks current context. The [offline browser check](offline-browser.json) verifies zero extra foreground context GETs, one acknowledgement GET, a visible success message, stale-branch rejection with no write, an independent online operation while backlog waits, exactly-once accepted references, unchanged offline workspace/modal structure, encryption and logout locking. An obsolete worker is exercised without clearing device storage.

The overview now reads up to 14 projected recent records per permitted module rather than building unrendered reports/review queues. Exact funded volumes, cash balances, role/module checks and branch scopes remain. Read-only navigation no longer creates tenant indexes; provisioning and mutation preflights remain. Independent counter writes and mobile overview reads run concurrently and all failures are observed.

The isolated scheduling probe adds **50 ms before each Mongoose query/aggregation**. It models the cost of serial reads, not actual Atlas latency; driver session operations are counted but not artificially delayed. Compare [before](latency-before.json) with [after](latency-after.json):

| Request | Commands before → after | Probe time before → after |
| --- | --- | --- |
| Tenant overview | 23 → 17 | 328 → 286 ms |
| Transfer entry | 10 → 9 | 371 → 320 ms |
| Mobile Money overview | 18 → 18 | 632 → 434 ms |
| Tenant sign-in POST | 10 → 10 | 354 → 301 ms |
| Platform sign-in POST | 9 → 9 | 278 → 229 ms |

Financial transaction fences, fresh authorization, rate limits and uniqueness constraints remain enforced. The financial integration checks cover exact balances, independent reviews, concurrent idempotency, rollback, insufficient funds and branch/currency isolation. Errors cannot replay POSTs, expose private exceptions or silently report success. Normal browser failures show a safe request page; API clients retain status codes and plain error responses.

Reproduce from the repository root:

```bash
npm run release:gate
npm run feedback:browser
npm run offline:browser
WORKSPACE_QUERY_DELAY_MS=50 npm run workspace-latency:integration
npm run db:doctor
```

The release gate runs all unit/integration checks on isolated local infrastructure. Browser checks additionally require optional Playwright and Chromium. The latency fixture refuses remote/authenticated/production storage, creates random databases and removes them. `db:doctor` is read-only and reports five database pings from the machine where it runs; this helps distinguish network delay from application work without printing connection credentials.

Final verification passed: **527 JavaScript tests with MFA enabled and disabled**, **552 JS/EJS syntax/template checks**, **13 Android relay tests**, all registered isolated integrations and the online dependency audit (zero vulnerabilities). The separate watched-server [onboarding check](onboarding-browser.json) passed platform/owner password login, empty-plan publication, tenant creation, subscription renewal, replacement activation and owner activation with one server boot.

The final Node **22.23.4** image built from the lockfile and started as UID **1000**, with a read-only root filesystem, dropped capabilities and no new privileges. It reported version 1.29.0 and explicitly disabled MFA. Readiness, public pages and feedback/workspace assets returned 200; protected dashboards returned 303 with no-store/noindex. It used local infrastructure; no public deployment or live provider delivery is claimed.
