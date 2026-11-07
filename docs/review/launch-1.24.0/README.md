# Launch candidate 1.24.0 — 7 November 2026

[Sanitized verification results](verification.json) describe this local launch candidate. Browser sessions used generated identities and disposable Mongo databases; no production records or provider API were used.

The full release gate passed 393 JavaScript tests, 13 Android relay tests, 473 JS/EJS syntax/template checks, all registered isolated database integrations and an online dependency audit with zero findings.

Fresh Chromium runs passed 84 protected/public layout checks and 52 final public page/viewport checks at 1440/900/390/320px, plus appointment scheduling/cancellation/completion, plan-empty tenant onboarding recovery, owner activation/MFA, wallet funding and default postings. They found no root overflow, duplicate IDs, unnamed visible controls, JavaScript errors or failed assets. Direct reference interaction checks confirmed approved sticky behavior and single input borders at 1440/390/320px.

The real production Dockerfile built from the lockfile and started on Node 22.23.4 as user node with a read-only filesystem, dropped capabilities and no public ports. Readiness/home returned 200; a mixed-case private request redirected 303 with no-store/noindex. The image contained no development MFA key or dot-env file. It used an isolated local Mongo fixture; this is not a test of live TLS, authenticated production storage, external delivery or recovery.

A read-only production configuration probe correctly rejected this development setup. The actual hostname, database service identities, mail delivery, backup/restore and capacity evidence remain unverified here. Follow [launch status](../../LAUNCH_STATUS.md) and the [production runbook](../../LAUNCH_RUNBOOK.md); repository checks do not issue a production certification.

[tenant-dashboard-1440.png](tenant-dashboard-1440.png) · [tenant-profile-390.png](tenant-profile-390.png) · [public-guide-390.png](public-guide-390.png) · [appointments-1440.png](appointments-1440.png)
