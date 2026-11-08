# Predeployment verification — 8 November 2026

The [full release gate](release-gate.txt) passed 414 JavaScript tests, 13 Android
relay tests, 484 JS/EJS syntax/template checks, all registered isolated Mongo
integrations and npm audit with zero vulnerabilities. After the final payout
privacy cleanup, [32 focused tests and both relevant financial integrations](final-focused.txt)
passed again. Test databases and browser identities were synthetic and isolated.

The [responsive browser results](responsive-browser.json) cover 35 layouts on
seven tenant/platform pages at 1440, 1121, 900, 390 and 320 pixels. They check
controls above titles, right-aligned actions, phone menu/scope/title/search/action
order, two-column stats and filters, centered active/inactive navigation dots,
sticky sidebar/modal behavior and accessible menu dismissal. The final phone
check hides the duplicate header Notifications button while preserving its
authorized sidebar destination. No overflow, duplicate IDs, JavaScript errors
or failed assets were found on these screens.

Representative captures: [tenant desktop](tenant-desktop.png),
[tenant phone](tenant-phone.png), [report filters on phone](report-phone.png)
and [platform phone](platform-phone.png).

The [sender-phone browser flow](sender-pin-browser.json) verifies typed names,
reviewed collection, one-time PIN, sender-phone check and reviewed payout with
balanced cash/payable journals. The SMS-disabled card is explicit.
`scripts/transfer-sms-integration.js` separately verifies encrypted atomic queue
creation, mock provider acceptance, competing workers, uncertain outcomes,
retry limits, owner/MFA revocation, legacy snapshots/PINs, delayed-source
suppression and spent-PIN privacy. No real SMS was sent.

The actual [web image](web-image.json) and
[notification-worker image](notification-image.json) ran as non-root users with
read-only filesystems, dropped capabilities and no public ports. The web passed
readiness/public/private response checks; the SMS-enabled worker produced a
heartbeat without receiving the web session or MFA keys. The worker used fake
provider credentials and an empty scratch database. These are local image tests,
not proof of production MongoDB permissions or real handset delivery.

The operating handbook was regenerated as Word, HTML and a tagged 29-page PDF.
See [deployment setup](../../DEPLOYMENT_SETUP.md) and the
[launch runbook](../../LAUNCH_RUNBOOK.md) for the real-host acceptance steps.
