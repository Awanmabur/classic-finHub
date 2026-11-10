# Automatic pricing, quick entry and connection recovery — 1.30.0

Candidate verified on 10 November 2026 (Africa/Kampala). This record describes the implemented contracts and final local verification. It does not certify a live host, Atlas deployment, Google consent, SMS delivery or production capacity.

Tenant Owners configure fixed-plus-percentage customer charges and separate cost estimates under **Fees & commissions**. Rules match the subscribed operation, currency, tenant/branch scope and optional Mobile Money network. Forex percentage pricing uses the converted settlement amount. A missing enabled rule means zero charge. The server derives amounts from its saved policy; a browser preview cannot set the fee. Cost estimates remain metadata and do not create an expense or reduce funds. Provider-observed SMS fees retain their original meaning.

Daily forms keep essential inputs visible and group optional metadata under **Additional details**. Existing operation modals reuse those same partials through a small authenticated form response instead of fetching full histories and review queues. New instructions receive new UUIDs; successful retries retain the original fee snapshot and reference. Pricing or branch changes on an unaccepted saved instruction require review instead of silently changing its business meaning.

The approved workspace automatically uses encrypted local storage when connection/service requests fail, including lost internet with Wi-Fi still connected. No second offline interface or separate business backend is introduced. Readiness checks run while offline or work remains pending, with bounded backoff and retry guidance; healthy idle pages do not poll. Recovery submits the original guarded routes and UUIDs after fresh server validation. An open editor retains its values; an idle saved page can refresh. Final payout, independent approval and funds/configuration changes still need current server state. Unvisited views require their first connected load or explicit preparation.

The cleanup removes only three proved unused files: the unmounted original dashboard template and unreferenced public.css/public.js copies. The approved root `index.html`, active assets, financial history and required deployment/recovery files remain.

## Final candidate evidence

The complete release gate passed: **544 JavaScript tests**, **567 JS/EJS syntax/template checks**, **13 Android relay tests**, all registered isolated integrations and the online dependency audit (**zero vulnerabilities**). The same 544 tests also passed with MFA disabled. New policy and all-module fee/ledger probes run inside the gate.

- [Pricing browser](pricing-browser.json): owner create/edit, frozen scope, stale edit field retention, currency-aware fixed-plus-percentage previews, zero per-keystroke requests, four operational modules and teller configuration denial passed at 1440/390 px. A forged hidden preview fee could not change the persisted amount. See [phone pricing setup](pricing-390.png).
- The actual fee integration verified bank deposit/withdrawal/account-transfer charges, FX settlement commission, transfer collection and MoMo wallet/cash postings. Journals and trial balances remained balanced, fees participated in insufficient-funds checks, historical zero-fee books remained compatible, accepted UUID retries retained their original price, stale policy prevented a new write, and estimated costs created no ledger postings. Transactional pricing audits preserve exact before/after rule amounts and revision; audit-failure rollback was verified.
- [Modal browser](modal-browser.json): visible fields appeared **19 ms after activation while the response was held** (123 ms including browser automation click/wait overhead). The thin response used five MongoDB finds and no history, report or branding queries; production also performs its ordinary persistent-session read. Warm and same-page reuse made no extra form GET. Selected USD, current receiving branches, unique references, caret/typed-value preservation, expired pristine refresh, edited/pending preservation and recovery from a failed seed load passed. See [phone transfer modal](transfer-390.png). This is a local browser measurement, not a live-host latency promise.
- [Offline browser](offline-browser.json): Wi-Fi/`onLine=true` network failure switched to local mode automatically; restoring routes without an online event or manual sync accepted the entry once while retaining the editor, values and UUID. A response lost after a real commit retried the same reference without duplication. Stale pricing and operating-branch changes were held for review without a write. Healthy idle startup made no context, preparation or readiness-poll requests. Same-page navigation/modals, encrypted storage, sanitized credentials inside inert form templates, old-worker update and logout locking passed at 1440/390/320 px. See [phone offline workspace](offline-transfer-390.png).
- Existing feedback and [watched-server onboarding](onboarding-browser.json) browser checks passed, including correct/incorrect login feedback, tenant creation, grant/replacement activation and one surviving server boot.
- The final Node **22.23.4** image started as UID **1000** with read-only root filesystem, dropped capabilities and no new privileges. Readiness, home and pricing/workspace assets returned 200; private dashboards returned 303 with no-store/noindex. It reported version 1.30.0 with explicitly disabled MFA. The image used local infrastructure; no public deployment or live provider delivery is claimed.

Reproduction uses isolated loopback replica-set databases, optional Playwright and Chromium:

```bash
npm run release:gate
node scripts/pricing-rules-integration.js
node scripts/automatic-pricing-integration.js
node tools/browser/pricing.cjs
node tools/browser/operation-modal.cjs
npm run offline:browser
```

The integration scripts must not target production data. For deployment, follow the [production runbook](../../LAUNCH_RUNBOOK.md), [operations manual](../../OPERATIONS_MANUAL.md) and [offline/recovery procedure](../../TENANT_BACKUPS_AND_OFFLINE.md). On the real server, verify MongoDB network latency, configured fees, end-to-end provider delivery, TLS/session access, representative load and an actual backup restore before relying on those services.
