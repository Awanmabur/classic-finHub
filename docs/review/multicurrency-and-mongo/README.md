# Branch currencies, MongoDB configuration and alert verification

Verified on 8 November 2026 against isolated synthetic data. No user-supplied
Atlas credentials were connected or tested, and no live SMS was sent.

- The [release gate](release-gate.txt) passed 432 JavaScript tests, 13 Android
  relay tests, 493 JS/EJS checks, every registered Mongo integration and npm
  audit with zero vulnerabilities. Fifteen focused form/secret checks passed
  after the final selected-currency context wording.
- New Mongo configuration integration proves separate trusted tenant database
  names/links, one shared MongoClient, cross-database commit/rollback and tenant
  isolation. Unit checks reject alias/base conflicts, namespace collisions and
  TLS weakening. Workers keep separate principals; Redis has no runtime consumer.
- Branch integration exercises UGX/USD/SSP/KES in one branch, independent cash
  shifts, legacy keys, concurrent openings, the compound unique cash index,
  selected subsets, guarded currency disabling and balanced journals.
- Expanded Mobile Money/SMS integrations prove distinct MTN SSD SSP postings,
  exact cents, matching-wallet checks, signed device enrollment, duplicate
  handling, currency-specific shifts and retained quota/revocation controls.
- [Browser results](browser-verification.json) cover 27 desktop/phone layouts
  plus real USD and SSP Mobile Money, reviewed transfer collection/payout,
  customer deposit/withdrawal and USD–SSP Forex buy/sell cycles. Cash and wallet
  books remain currency-specific, and both trial balances are balanced.
  There were no document overflows, duplicate IDs, JavaScript or asset errors.
  Representative captures: [MTN SSD on phone](mtn-ssd-phone.png) and
  [branch operating currencies](branch-currencies.png).
- The actual [web image](web-image.json) and
  [notification-worker image](notification-image.json) pass isolated startup
  checks as non-root users with read-only filesystems and dropped capabilities.
  Worker web/session secrets are absent. This does not validate live Atlas
  privileges, external provider delivery, TLS hosting or recovery.

The three reported GitHub alerts point to credential-shaped documentation
placeholders in commit `deb2434`. The fix was pushed as `1a1231c`, and
`npm run secrets:check` prevents the same pattern from entering the current tree.
No working credential was present at those three locations. GitHub API egress
is unavailable here; the alerts remain for an authorized maintainer to resolve
as **False positive**, with reason “Documentation placeholder; credential-shaped
example removed.” No Git history was rewritten.

The operating handbook and MongoDB setup instructions reflect the new behavior.
See [deployment setup](../../DEPLOYMENT_SETUP.md) and
[launch status](../../LAUNCH_STATUS.md) for actual-host acceptance requirements.
