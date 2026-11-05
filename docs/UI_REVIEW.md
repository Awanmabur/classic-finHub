# UI review against the approved `index.html`

The user identified the uploaded root `index.html` as the approved design. It is a
browser-only prototype, including locally simulated transactions and demo data.
The running application renders authenticated EJS pages. This review distinguishes
visual defects from missing backend capabilities; the prototype is retained as
the design reference and is not published as an alternative financial application.

## Changes completed in this review

| Finding | User impact | Correction |
| --- | --- | --- |
| Dashboard logo used `images/...` relative to the CSS URL | Browser requested `/css/images/classicfinhub-logo.png`, which did not exist | Corrected both logo declarations to `/images/classicfinhub-logo.png` |
| Global `body *` font override forced icons to use the text font | Font Awesome navigation/action icons could show missing glyphs | Removed the universal descendant font override; text retains the approved inherited/component font rules |
| Prototype print rule hid every `.view` except `#view-reports` | Actual EJS reports have no prototype ID, producing blank dashboard/report printouts | Print the active `.view.show`; keep hidden views hidden |
| Tenant overview showed only one module's primary statistics | A tenant entitled to multiple modules could not see a snapshot for each | Restored the approved snapshot-card arrangement with separate authorized module tiles and real record counts |
| Overview/topbar lacked working shortcuts | Operators had to navigate the sidebar for routine actions | Restored permitted new-record/request/quote actions and history links, derived from the authorized menu and role permissions |
| Sidebar group headers were buttons with no action | Keyboard and screen-reader users encountered dead controls | Group labels are semantic headings; current page is announced on active links |
| Mobile drawer had no Escape, focus containment, or expanded state | Keyboard users could reach obscured/offscreen controls and struggle to close navigation | Added Escape, focus return/trapping, `aria-expanded`, responsive reset and `inert` on the closed mobile sidebar |
| Dashboard search had only placeholder text | Search lacked an accessible name | Added an explicit search label; added a keyboard skip link to the workspace |
| Sidebar footer overflowed with long names and exposed a database identifier | Owner names/context tags could be clipped, while database naming occupied product UI | Footer content now wraps within the sidebar; the useful workspace slug replaces internal database naming |
| Public JavaScript stopped when browser storage was disabled | Navigation and hidden reveal content could stop working | Theme storage is optional; reveal content stays visible when IntersectionObserver is unavailable |
| Public navigation observer cleared normal page highlights | Inner-page navigation could lose its active indicator while scrolling | Section observer only handles fragment navigation links |
| Motion preferences were ignored | Reveal blur/animations could affect motion-sensitive users | Added reduced-motion overrides without changing the default approved design |
| Password activation/reset guidance allowed more than bcrypt's safe input limit | Frontend guidance disagreed with server validation | Guidance now specifies 14+ characters and a maximum of 72 UTF-8 bytes; fields cap input at 72 characters |

The platform overview now also uses the snapshot-card and quick-action arrangement.
Inter and Font Awesome are served from local vendor assets so the application does
not depend on font CDN availability. The approved colors, glass panels, rounded
controls, grouped sidebar, typography and responsive grid rules are retained.

## Prototype integration continuation — 5 November 2026

This iteration uses the **root index.html solely as the approved visual and interaction reference**.
The active authenticated pages still render from EJS with persisted data and
server-side permission, branch and module checks. No demo transaction code was
copied into the application, and the original reference HTML was not changed.

Completed in the current GitHub master branch changes:

- **Navigation:** Original-style service sections for Overview, Money Transfer,
  Mobile Money, Banking, Forex, reporting and administration. Submenu operations
  are linked to the actual implemented pages; subscription and user permissions
  govern whether each action appears. Nested-page highlighting is preserved.
- **Secure modals:** The real POST forms for transfer requests, Mobile Money
  records, Banking requests, Forex rate proposals and quotes, staff invitations,
  branch creation, approval requests and notification sending/templates open
  with the reference dashboard's sheet/overlay presentation. They keep their
  original action, CSRF field, idempotency key (where applicable) and server checks.
  Without JavaScript the original forms remain accessible as regular forms.
- **Quick actions:** The Overview/sidebar and topbar New Transaction launcher
  offers only permitted module operations. Direct links open their module forms,
  with Mobile Money cash-in/cash-out and Banking request types preselected using
  allowlisted values, never auto-submitted.
- **Last acknowledgement:** Latest visible recent Mobile Money or Money Transfer
  record links to the existing tenant-scoped, protected acknowledgement page.
  This is **not a payment receipt**, an all-time global lookup, or evidence of
  settlement; only already authorized data can be selected.
- **Platform:** The existing real tenant/appointment/module totals are retained,
  using the reference design's summary cards.
- **Continuous integration:** Unit, security audit and isolated replica-set
  integration tests are required. Ubuntu 22.04 is used to avoid the MongoDB 8
  startup guard on newer host kernels; this is a CI runner choice, not a
  downgrade or a production database change.

Still **not implemented / not safe to activate from the prototype**:
- PIN payout and actual remittance; bank deposit/withdrawal/transfer settlement;
  executed FX buy/sell trades and currency stock; live balances and profit claims.
  These require verified external providers, transaction ledgers, reconciliation,
  permissions, independently tested reversal and recovery processes.
- Unified global branch/currency filtering across every module, account/customer
  directory and generic business expense management. Module-specific controls
  exist, but global controls should not be decorative.
- A universally latest receipt across all history and providers. The present
  acknowledgement shortcut is based on bounded recent authorized records.

**Quality boundary:** Passing automated tests establishes code and integration
gates, not pixel-perfect design parity, browser assistive-technology coverage
or authorization to move real customer money.

## Deliberate remaining differences from the prototype

| Approved prototype element | Running application behavior | Work needed before exact functional equivalence |
| --- | --- | --- |
| Global branch and currency selectors | Branch/currency controls exist inside supported module forms; the sidebar identifies the workspace | Define one server-validated, cross-module branch/currency filtering contract, persist selection, and apply it to every list/summary with authorization tests; adding decorative selectors would suggest filtering that does not happen |
| Transfer/mobile/banking/forex monetary volume cards | The snapshot displays daily Mobile Money record counts and explicitly labelled recent request/quote counts | Add authorized, bounded database aggregates with explicit time windows and separate currencies; recent paginated list counts must not be labelled complete daily totals |
| Generic "New transaction" sheet | Implemented: permission-filtered chooser with original-style modal presentation; opens each real secure module form | Add comprehensive browser/modal and accessibility verification; provider execution still requires actual backend integrations |
| PIN payout, executed banking/FX operations and cash balances | Internal instructions, quotations, review and physical cash evidence are labelled according to what they actually record | Implement and independently validate provider execution, reconciliation and accounting before presenting settled funds or executable payout controls |
| "Last receipt" | Implemented as last *visible recent acknowledgement* from already authorized Mobile Money and Money Transfer records, never a settlement receipt | A global latest historical receipt across modules needs a separate backed query and additional settlement boundaries |
| Load demo / Reset | No controls that fabricate financial activity or erase records | Keep any future demo mode isolated from real tenant records and clearly identified |
| One browser-only navigation surface for all roles/modules | Server pages and menus reflect role, branch and subscription access | Preserve authorization boundaries; unsupported or unassigned modules should not appear as working controls |
| Customers, customer accounts, legacy open/close day and expense actions | Legacy services remain unavailable; newer module-specific contacts and cash shifts are implemented | Implement the missing domain models, permissions, transaction/audit rules and UI, rather than reconnecting prototype arrays or legacy stub controllers |

Public/authentication pages retain the uploaded project's existing public design.
The approved `index.html` specifies the operations dashboard; it does not establish
a separate public-site redesign. Several `src/views/public`, `src/views/auth` and
`layouts/platform.ejs`/`layouts/tenant.ejs` files are older unused alternatives.
The active public routes generally render `src/views/original/*.ejs`; both active
dashboards render `layouts/dashboard.ejs`. Cleanup should follow route/template
coverage to avoid editing a dead template while leaving the live UI unchanged.

## Validation and limits

`tests/frontend-regressions.test.js` exercises mobile drawer keyboard behavior,
blocked browser storage and missing observer support, actual HTTP resolution of
dashboard CSS image URLs, multi-module snapshot rendering, and read-only menu
restrictions. The focused run with `review-views.test.js` and
`tenant-administration.test.js` passed **17 tests**.

Chromium browser validation exercised platform tenant creation, owner invitation
activation, MFA enrollment and the authenticated tenant dashboard at desktop
1440 px and mobile 390 px widths. Screenshots are retained locally under
`/workspace/classicfin-review-evidence/` (platform, created tenant, desktop tenant
and mobile tenant views). Desktop inspection also identified the footer overflow
corrected above.

This is not a claim of pixel-perfect equivalence or a completed accessibility
audit. Screen-reader checks, print preview and representative full datasets remain
necessary additional evidence.
The design differences above must remain visible in the project backlog until
their backend contracts and UI acceptance checks are complete.

Final accepted desktop/mobile captures: [desktop](review/tenant-desktop.png), [mobile](review/tenant-mobile.png), [platform](review/platform-desktop.png). These captures use disposable test accounts and demonstrate the current implementation, not exact prototype parity.


## Visual cleanup after the follow-up review

The live EJS navigation uses anchors, while the approved prototype used buttons.
Without an anchor reset, browser-default underlines appeared throughout navigation
and action buttons. The shared dashboard now defines link, hover, visited and
keyboard-focus styles explicitly, preserving intentional inline-link affordances.

This pass also removed repeated Create actions and duplicate flash notifications,
replaced heavy noninteractive navigation headings, condensed empty activity panels,
removed search from screens without searchable records, and kept the closest
navigation entry active on nested pages. Form controls and staff module selection
now share consistent sizing. Mobile activation guidance wraps instead of clipping;
the closed drawer and its shadow are fully hidden. Tenant screens use workspace
and owner information instead of database filenames and implementation commentary.

Public pricing and comparison previously indexed plans by position. Inserting
Modular Workspace shifted Agent, Finance and Enterprise prices and limits onto
the wrong cards. These screens now resolve plans by stable codes, with regression
coverage that deliberately reorders the catalogue. Public mobile navigation has
one sign-in entry and scrolls within the viewport. Reduced-motion users no longer
see blurred reveal sections.

Final Chromium validation covered **32 routes and 96 route/viewport combinations**
at 1440, 768, 390 and (for the creation form) 320 pixels. Checks passed for actual
HTTP rendering, no document-wide horizontal overflow, navigation/button text
without unintended underlines, correct icon fonts, contextual search, exactly one
active navigation entry, mobile drawer closing and visible printed content. The
real flow still sets up plans, creates a tenant, activates its invitation and
enrolls owner MFA. Public reduced-motion checks also passed at 320 pixels.

The full local release gate passed **256 tests**, all module/tenant/auth database
integrations and the advisory audit (zero findings). These visual checks do not
establish exact prototype equivalence or a full screen-reader/production audit.

Updated captures: [tenant dashboard](review/tenant-desktop.png),
[mobile dashboard](review/tenant-mobile.png), [platform](review/platform-desktop.png),
[mobile tenant creation](review/create-tenant-mobile.png).
