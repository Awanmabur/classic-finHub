# Transfer entry, operational Workspace and handbook review

Reviewed on 7 November 2026 against isolated local scratch databases. Browser
data, parties and balances are synthetic; no production tenant data was used.

## Implemented behavior

- Tellers type sender/receiver names, international phones and countries in
  both the transfer page and transaction dialog. No saved contacts are required
  or silently created. Direct party snapshots remain attached to the order.
- Identical retries return the existing order; changed parties conflict. Invalid
  phones/countries and mixed direct/contact input are rejected. Legacy saved
  orders remain readable and service callers remain compatible.
- Workspace reads fresh account/module access and real branch assignments,
  independent reviewers, reviewed account openings, verified cash shifts,
  customer accounts and applicable FX rates. Its setup indicator does not
  certify available liquidity or live provider balances.
- Real opening, observation, funding, adjustment, shift and subscribed operation
  queues link to the existing controls. Pending funded movements link to the
  oldest exact record, including under the All branches view.
- Unsupported import creation is removed from the primary UI. Working exports
  remain available and policy records are secondary configuration notes.

## Browser evidence

[Verification results](browser-verification.json) record a real collection,
receiver/PIN check and reviewed payout without any directory contacts. Cash
changes from UGX 1,000,000 to 1,010,100 at collection, then 1,000,100 after payout;
transfer payable returns to zero and the journal balances. Self-review is
rejected and a PIN can be revealed only once.

Workspace moves from blocked setup to setup checks complete after actual funds
review and shift verification. A pending collection appears in its working
queue; an unknown bank opening requires attention. Main, All, single-active-
branch and ordinary-role access cases passed. Twenty responsive captures at
1440, 900, 390 and 320 pixels found no document overflow, duplicate IDs,
JavaScript errors or failed assets. This covers changed screens, not a claim
that every page is pixel-identical to the approved design.

Representative screenshots: [Workspace desktop](workspace-desktop.png),
[Workspace mobile](workspace-mobile.png), [transfer desktop](transfer-desktop.png)
and [transfer mobile](transfer-mobile.png).

## Operating handbook

The [canonical manual](../../OPERATIONS_MANUAL.md) covers 21 operating areas,
from platform bootstrap and tenant activation through each subscribed workflow,
independent review, daily closing, reports, incidents and final handover. Its
contracts were checked against current services and role permissions. Same-
branch transfer payout and manual/provider boundaries are explicit.

The [Word](../../operations/OPERATIONS_MANUAL.docx) and
[tagged PDF](../../operations/OPERATIONS_MANUAL.pdf) derive from the
same source. Word structure, PDF text and representative table/page layout were
inspected. Rebuild instructions live in [tools/docs](../../../tools/docs/README.md).

## Verification commands

The full `npm run release:gate` passed: 402 JavaScript tests, 13 Android relay
tests, 477 JS/EJS syntax/template checks, every registered isolated Mongo
integration and zero dependency vulnerabilities. It includes the new guarded
`workspace-operations:integration` check and expanded `transfer:integration`.
Run the gate only with isolated local/staging infrastructure. Actual public
hosting, delivery, backup restoration and production capacity acceptance retain
the requirements documented in the [launch status](../../LAUNCH_STATUS.md).
