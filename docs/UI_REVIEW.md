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

## Deliberate remaining differences from the prototype

| Approved prototype element | Running application behavior | Work needed before exact functional equivalence |
| --- | --- | --- |
| Global branch selector | Removed by the user’s updated requirement; account/device assignments determine transaction location | The resolved branch and currency are displayed, not selected. Administrative staff/owner branch assignment remains configurable. |
| Transfer/mobile/banking/forex monetary volume cards | The snapshot displays daily Mobile Money record counts and explicitly labelled recent request/quote counts | Add authorized, bounded database aggregates with explicit time windows and separate currencies; recent paginated list counts must not be labelled complete daily totals |
| Generic "New transaction" sheet | Implemented: the permission-scoped launcher loads real protected forms into the approved centered modal | Provider execution remains a separate backend integration; modal saves create the supported records, requests or quotes. |
| PIN payout, executed banking/FX operations and cash balances | Internal instructions, quotations, review and physical cash evidence are labelled according to what they actually record | Implement and independently validate provider execution, reconciliation and accounting before presenting settled funds or executable payout controls |
| "Last receipt" | Overview and module pages link to authorized history; supported record pages have non-settlement acknowledgements | Define a tenant/branch-scoped latest acknowledgement lookup; a mock receipt would be misleading |
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


## Configurable plans and SMS-assisted workspace update

The later feature pass adds the real transaction chooser/sheets, Open cash shift,
a context-aware Close cash shift link, scoped recent activity, provisional physical
cash and the latest real acknowledgement. No transaction branch selector remains;
operator/device context is checked server-side. The new Plan editor and SMS inbox,
enrollment and review screens were checked in Chromium at 1440, 390 and 320 pixels.
Real browser saves exercised plan drafts, device enrollment, manual transaction
entry and cash-shift opening. The source template is unchanged.

See [the feature guide](SMS_AND_PLAN_CONFIGURATION.md) for pricing, Android setup,
provider-format coverage and remaining prototype-only workflows. Screenshots:
[transaction modal](review/transaction-sms-enabled-1440.png),
[mobile transaction modal](review/manual-cash-in-320.png),
[plan editor](review/plan-new-320.png), [SMS inbox](review/sms-owner-320.png).
