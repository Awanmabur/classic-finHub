# Project review — updated 7 November 2026

The current launch candidate is 1.24.0. Use [launch status](LAUNCH_STATUS.md) and the [production runbook](LAUNCH_RUNBOOK.md) for the current deployment decision. Earlier verification counts and file references below are historical where superseded by the current launch evidence and cleanup manifest.

This register covers the uploaded application reviewed and repaired in this session, including onboarding, tenant administration, financial recording, authentication, dependencies, and the active EJS interface. It records confirmed findings and concrete remaining work. It is not an exhaustive security audit, a claim that every screen matches the approved prototype, or approval to process real funds.

The active dashboards use `src/views/layouts/dashboard.ejs` and the mounted routers in `src/platform/routes/index.js` and `src/tenant/routes/index.js`. The approved root `index.html` is a design reference containing browser-local simulations. A template or legacy controller existing on disk does not establish a working application feature.

Priority: **P0** blocks real financial deployment or requires operational action; **P1** blocks an intended development/product workflow or causes incorrect results; **P2** affects usability, scale, maintainability, or evidence quality. A fixed finding can retain its original priority.

## Approved UI follow-up — 6 November

[Approved UI implementation and remaining boundaries](APPROVED_UI_PARITY.md) records the complete seventy-item navigation, five Mobile Money pages, real customer/account/expense/settings workflows and the distinction between pending instructions and financial execution. New checks cover fresh authorization inside transactions, concurrent independent expense decisions, USD/SSP minor units, published landing snapshots and shared-IP navigation limits.

The account directory is connected to banking instruction selectors. An instruction remains pending until its separate funded manual movement is independently approved; that review posts the real internal customer liability and funds accounts together. [Manual balances, reconciliation and posting](MANUAL_FUNDS_AND_UI.md) documents the current workflow. New module entitlements require an explicit plan publication or grant with a positive record allocation. Existing immutable subscription snapshots are preserved.

## Confirmed defects fixed

Follow-up: the first repair still left a fresh database with an empty plan
selector and disabled Create button unless an operator ran the publication
command. The tenant screen now offers **Set up plans and continue**, an audited,
MFA/CSRF-protected administrator action. After publication it returns to the
working tenant form. The form also shows validation and creation progress.
The HTTP integration and Chromium acceptance now start with no published plans
and recover through this in-app action before creating and activating a tenant.

| ID | Priority | Confirmed issue and user impact | Correction and evidence |
| --- | --- | --- | --- |
| F01 | P1 | First catalogue publication passed multiple documents to Mongoose `create()` inside a session without `ordered: true`; the command failed, leaving the tenant plan selector empty and tenant creation blocked. | Ordered transactional catalogue insertion in `commercial.service.js`. Dedicated catalogue integration covers initial publication and repeatability; tenant integration starts with an empty catalogue, checks rejection, publishes, and creates a tenant. |
| F02 | P1 | Ledger posting used the same unsupported bulk-create transaction pattern, preventing a journal with multiple posting lines from completing. | Ordered posting creation in `ledger.service.js`; real replica-set ledger and financial integration checks pass. Posting and audit operations retain transaction boundaries. |
| F03 | P1 | Tenant creation discarded the submitted phone number. It accepted owner names longer than the activation account schema allowed and email addresses that could not authenticate. Explicit uppercase slugs failed, and accepted long slugs generated database names exceeding MongoDB's limit. | Contact persistence, shared email normalization, owner/phone validation, lowercase explicit slugs, bounded generated slugs, and a shared 3–42-character slug rule. The longest supported slug produces a 63-byte database name. Four new unit tests and real HTTP tenant provisioning/activation pass. |
| F04 | P2 | Tenant validation/duplicate failures replaced the form with plain error text; submitted fields were lost. The selector used static catalogue labels instead of the latest published eligible terms. | Create form retains escaped values and displays actionable HTTP 400/409 feedback. It displays current published trial plans. HTTP integration verifies invalid input, duplicate slug, missing catalogue, successful invitation, single-use activation, and owner sign-in. |
| F05 | P1 | Submitting a physical cash closing count subtracted a `BigInt` balance from a `Number`, throwing on the cash close workflow. | Normalize the closing count to exact `BigInt` arithmetic in `cashDrawer.service.js`. Cash regressions cover exact, positive/negative variance and KES; real opening, independent verification, record, close and review integration passes. |
| F06 | P2 | Negative fractional KES amounts rendered incorrectly, for example `KES 0.-5`. | Separate the sign from the absolute major/minor values in `mobileMoney.service.js`; money-format regression verifies `KES -0.05` and related cases. |
| F07 | P1 | The infrastructure doctor demanded Approval Workflows indexes but omitted their models from its registry, falsely reporting missing tenant indexes. | Register `ApprovalPolicyV1` and `ApprovalRequestV1` in `infra-doctor.js`; model-registry regression and the real infrastructure doctor pass. |
| F08 | P1 | Development MongoDB exhausted its file-descriptor limit while creating tenant collections/indexes, then crashed and restarted with exit 139. Valid tenant creation consequently returned HTTP 500. | `deploy/compose.dev.yml` explicitly sets supported `nofile` soft/hard limits to 16384. The existing development volume was retained. Mongo recovered as PRIMARY and the tenant lifecycle/integration checks passed. This local fix does not establish production database availability. |
| F09 | P1 | bcrypt accepted only the first 72 UTF-8 bytes while the application allowed longer passwords; strength characters after the boundary were ignored by authentication. | Enforce the 72-byte maximum on creation/reset/login and align password guidance. Exact-boundary, ASCII and multibyte tests pass. Existing accounts whose old password exceeded 72 bytes need password recovery; hashes cannot recover discarded suffixes. |
| F10 | P1 | Error handling logged raw exception messages and returned JSON-parser messages that could quote submitted tokens or credentials. | Generic malformed-JSON responses and safe error classifications replace raw input/error text. HTTP regression confirms a private malformed value is absent from the response and logs. See [security review](SECURITY_REVIEW_2026_11_05.md). |
| F11 | P0 | The initial connected audit identified 6 vulnerable packages: 1 critical, 4 high and 1 moderate. | Dependency versions/lockfile were repaired without disabling verification; the current connected npm audit reports zero vulnerabilities. This is a point-in-time advisory result, not proof that dependencies contain no defects. Rerun the audit for each release. |
| F12 | P1 | The original Git checkout tracked `.env` and the complete `node_modules` directory, coupling source to local configuration and installed artifacts. | Remove these paths from the tracked snapshot and retain ignore rules; install dependencies from the lockfile. This does not erase earlier Git history or prove old credentials were never exposed. Review/rotate any real credentials previously committed. No secret value is included in this report. |
| F13 | P2 | Some integration fixtures bypassed current independent cash-opening approval, Reports grants, or role assignments; other fixtures spread Mongoose documents instead of their persisted plain fields. They failed before exercising the intended workflow. | Repair auth/admin/module/transfer/analytics fixtures to follow the actual contracts. Application checks were retained. The affected real integration scripts now pass; authentication verifies recording is rejected before opening and before independent approval. |
| F14 | P2 | Active UI defects included broken dashboard logo URLs, icon-font overrides, blank report printing, dead sidebar headings, inaccessible mobile navigation/search, and public navigation failures when storage/observer APIs were unavailable. | Repair active CSS/JS/templates, restore authorized snapshot cards/actions, use local font assets, and add focused frontend regressions. Detailed changes and remaining design differences are in [UI review](UI_REVIEW.md). Authenticated Chromium acceptance passed at desktop/mobile sizes; exact visual parity and full accessibility/print acceptance remain separate work. |

## Confirmed product gaps remaining

These are observed capabilities missing from the current application. They must be planned explicitly; the fixes above do not implement them.

| ID | Priority | Remaining gap | Source evidence and next work |
| --- | --- | --- | --- |
| R01 | P0 for automated provider execution | Live provider balance APIs and automated settlement remain unavailable. Reviewed manual cash, wallet, bank, forex-stock and transfer-payable movements now post to the internal ledger; their dated actual observations do not provide a live external balance. | See `treasury/service.js`, `fundedOperations.service.js` and the manual funds guide. Legacy provider execution services and `REAL_MONEY_ENABLED` remain closed. Live provider adapters, authenticated callbacks and production settlement evidence remain required for automated provider execution. |
| R02 | P1 | Payment collection, recurring billing and real invoice issuance are not active workflows. Subscription/module grants are manual entitlements, not evidence of payment. | Platform router has no invoice/payment handlers; legacy route modules are empty and fall through to HTTP 501. `billing.service.js::recordPayment()` is unavailable; invoice/payment-status jobs throw instead of claiming success. Implement the complete commercial lifecycle, provider integration, invoice numbering/tax rules and reconciliation before exposing payment controls. |
| R03 | P1 | Legacy standalone role editing, platform users/settings and some unused legacy routes remain unimplemented. Customers, ledger-mapped accounts, reviewed funded expenses, workspace settings/landing snapshots and shared cash controls now have active database workflows. | Mounted platform/tenant routers end with explicit HTTP 501 responses; corresponding legacy routers are empty or services call `unavailableOperation`. The active menu uses the implemented customer/account/expense/workspace/cash routes. Keep unsupported legacy alternatives closed and implement any remaining administration workflow with permissions, validation, audit rules and acceptance tests. |
| R04 | Fixed in 1.24.0; delivery evidence remains | Appointment requests can now be scheduled/rescheduled, cancelled and completed through audited administrator actions with fresh MFA/account checks and optimistic concurrency. | Real Mongo and rendered-browser tests cover state transitions, invalid URLs/dates, early completion, concurrent decisions and audit rollback. Contact delivery remains a separate configured channel; saving a decision does not claim an email was delivered. |
| R05 | P1 | Customer Portal remains disabled; arbitrary runtime module publishing/toggling is unavailable. | `src/data/store.js` marks `customer_portal` disabled; `module.service.js::toggleModule()` fails closed. The existing plan/module entitlement grants do not supply those product capabilities. |
| R06 | P1 | Live messaging is incomplete in this environment. A Resend email adapter and durable workers exist, but provider delivery has not been demonstrated; outbound SMS sending is explicitly unavailable. Inbound Android SMS capture is now implemented separately. | `config/mail.js` requires `RESEND_API_KEY`/`MAIL_FROM`; its result is provider acceptance, not final delivery. `config/sms.js` rejects sending. Configure secure bindings and verified sender/domain, exercise provider errors/retries and delivery evidence; implement an approved SMS adapter separately. Password rotation/session revocation were verified without claiming a notification email was delivered. |
| R07 | P2 | Several administrative lists can silently omit older records without a next-page control. Page search only filters rows already loaded in the browser. | Platform tenants/subscriptions use `limit(100)`, appointments `limit(150)`, platform/tenant audit views `limit(100)`, staff `limit(100)`, branches `limit(500)`. `public/js/dashboard.js` searches `[data-search-row]` only. Add scoped server search, cursors, stable ordering and visible total/truncation states. Module requests and several module histories already have pagination; reuse those contracts where suitable. |
| R08 | Fixed; production-scale capacity unverified | Tenant-wide Main/branch/All viewing, assigned transaction branches and exact currency-separated posted-volume aggregates now exist. | Branch-view HTTP/Mongo tests cover read scopes and unchanged write assignments; 16 reporting browser checks preserve filters and view. Local response timing is not a production capacity guarantee. |
| R09 | Tested components fixed; broader acceptance remains | The unified launcher, receipt shortcut, filtered navigation, sticky behavior, approved input structure and clean container spacing are implemented. Prototype-only provider actions remain separate. | Current launch browser evidence covers 1440/900/390/320 layouts, input accessibility checks and direct reference interactions. This does not certify every data population, assistive technology or production load scenario. |
| R10 | Verified cleanup completed | 153 disconnected legacy files and unused assets were removed after entrypoint, import, dynamic-template and static-URL checks. | [Cleanup rationale](DEAD_CODE_CLEANUP.md) and the exact hash/path manifest record the removals. Historical README release material is archived; current entrypoints and launch instructions are in the root README. Dynamic reachability is documented rather than claiming no unused line can remain. |
| R11 | P2 | Automatic invoice, payment-status, trial-reminder and report-generation jobs are placeholders, not verified scheduled services. | The respective `src/jobs/*.job.js` modules throw an explicit unimplemented error and are not scheduled. This differs from implemented outbox/notification workers and module expiry tasks. Specify scheduling, idempotency, ownership, retry/monitoring and database permissions before enabling each missing job. |

## Production work still unverified

The following items require deployment/provider evidence rather than another local passing unit test:

- Real provider execution, webhook authenticity, settlement/reconciliation, chargebacks/reversals, financial controls, and jurisdiction-specific licensing/KYC/AML requirements for the intended business.
- Deployed HTTPS, reverse-proxy trust, cookie behavior, secret/credential rotation and least-privilege MongoDB/worker identities. Tenant databases share a Mongo deployment/pool; this is logical isolation, not separate clusters or per-tenant credentials.
- Live email delivery and failure handling, SMS integration, scheduled worker supervision and alert reception.
- Production backup encryption/key custody, offsite retention/immutability, an actual restore/PITR rehearsal, disaster recovery objectives, and deployment rollback. Local backup/unit simulations do not establish recovery of real production data.
- Representative concurrency/load/soak tests, query plans and large-tenant data behavior; external security testing and authenticated browser/accessibility acceptance. No exhaustive security or performance assurance is claimed.
- Review of any secrets previously present in Git history. Removing a tracked `.env` from the current tree does not revoke or remove historical credentials.

## Verification record

The following completed results were reported by the work owners in this session. Focused suite counts overlap; do not sum them. The final post-polish release gate passed **248 tests**, with zero failures or skips, and static checks for **461 JS/EJS files**.

| Check | Status and scope |
| --- | --- |
| Tenant unit/security checks | Passed: 4 new tenant regression tests and 13 direct security tests at the time of the tenant change. Later security-owner runs are reported below; these counts overlap and must not be added. |
| Tenant HTTP + replica-set integration | Passed: empty catalogue, publication/repeatability, admin/MFA, validation feedback, max-length slug, contact persistence, duplicate rejection, invitation activation/replay and owner sign-in. Random scratch databases cleaned. |
| Focused security/auth/MFA/tenant suite | Passed: 40 tests, zero failures/skips, per [security review](SECURITY_REVIEW_2026_11_05.md). Counts overlap other focused runs. |
| Authentication HTTP + replica-set integration | Passed after fixture correction, including cash-opening controls, MFA, scoped dashboards, reporting authorization, password reset and session revocation. Live security email was not delivered/configured. |
| Catalogue/admin/review/database/commercial/outbox/ledger/financial/module/transfer/banking/forex/analytics/approval/notification integrations | Individual local replica-set runs passed after the confirmed fixes and fixture corrections; the sequential release gate also passed. |
| Focused UI regression/render checks | Passed: 17 tests across frontend regressions, review views and tenant administration, per [UI review](UI_REVIEW.md). Source/template checks do not establish visual equivalence. |
| Dependency advisory audit | Connected npm audit: 6 vulnerable packages initially (1 critical, 4 high, 1 moderate), zero after the dependency repair. Recheck for release/current advisories. |
| Full sequential `npm run release:gate` | Passed in the completed root-agent run; final log `/tmp/classicfin-release-verified.log` ends with successful local release checks and zero audit findings. |
| Authenticated browser acceptance | Passed actual Chromium checks at 1440px/390px: admin sign-in/MFA, tenant creation, invite activation, owner sign-in/MFA, branches/staff/billing/modules HTTP 200, mobile drawer Escape, no horizontal overflow, no page errors or failed assets. Evidence is retained in `/workspace/classicfin-review-evidence`. This is not pixel-perfect or comprehensive accessibility/print certification. |
| Production deployment, provider payments/delivery, production restore/load/security certification | Unverified; outside the local results above. |

A useful next product milestone is complete, tested onboarding and internal recording for the currently enabled modules, followed by explicit delivery of the missing administration/billing/domain workflows. Real-money capability requires its separate provider, accounting, operational and regulatory acceptance work.


## Subsequent feature delivery

The original register above is historical evidence for the first review. Custom
plan creation/versioning/public prices, premium SMS-assisted plans, signed inbound
Android relay capture, branch-derived transactions and real dashboard operation
modals are now implemented. These supersede the relevant plan/inbound-SMS/modal
limitations in the earlier register. Outbound SMS sending, provider execution and
other unfinished legacy domain workflows remain separate. See
[the current feature guide](SMS_AND_PLAN_CONFIGURATION.md).
