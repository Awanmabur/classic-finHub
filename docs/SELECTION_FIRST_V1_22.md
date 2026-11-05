# ClassicFin Hub v1.22 — Selection-first forms and integration checklist

## Design decision

An existing value should be chosen instead of re-entered. New information such as legal names, notes, account reference suffixes, transaction amounts, verified network references and passwords still requires user input. Dropdowns and checkboxes are **presentation only**: the backend must validate identifiers, scope, allowed values, quotas and permissions independently.

## Delivered

| Module | Updated selector | Backend guarantee |
|---|---|---|
| Money Transfer | 249 ISO country names, including Uganda, Kenya, South Sudan; no country silently selected | ISO code allowlist and existing E.164 phone validation |
| Money Transfer | Expiry period 1–30 days | Existing range limits, branch and idempotency checks |
| Banking | Previously registered institution names in branch plus explicit new option | Selected names checked against tenant/branch active references; new name still validated |
| Banking | Expiry period 1–30 days and selected branch's currency | Backend request validation and scoped active reference checks |
| Forex | Rates valid 1–72 hours, quotes valid 5–60 minutes | Existing independent approvals and expiry validation |
| Approval Workflows | Common expiry presets plus optional custom hours (1–720) | Existing policy validation and version snapshots |
| Notifications | Existing template codes offered as suggestions | Existing versioning/role checks and no raw HTML execution |
| Public onboarding | Individual selectable active modules | Server accepts known module keys only and supports cached old bundle values |
| Platform Admin | Readable module names in appointment table | Stored normalized module keys remain unchanged |
| Mobile Money | Currency follows selected branch | The existing backend verifies branch currency and allowed branches |

The completed standalone Operations Reports and Analytics services are unchanged; no extra entitlement is required for these UI improvements. Existing bank/account and branch selectors remain database-backed.

## Setup and regression checks

Apply the patch only to v1.21 and back up uncommitted changes.

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run perf:smoke
```

On your disposable local MongoDB replica set, perform the existing full integration checks. For live release, obtain an online `npm audit --audit-level=moderate` result, perform real tenant/branch integration tests, run staging browser checks for mobile selection and keyboard accessibility, then run the project's `npm run release:gate`.

## Manual acceptance scenarios

1. Register a sender in the Kenya branch, select Kenya by name, and confirm the stored country code is `KE`. Try forging `ZZ`; expect rejection.
2. Create a bank reference for an institution, then create another in the same branch: the institution should be selectable. Try posting an institution from a different branch as an existing selection; expect rejection.
3. Select the KES branch and ensure the Banking and Money Transfer request forms offer KES. On Mobile Money, changing branches should update currency; altered client submissions must still be rejected by the backend.
4. Choose any combination of enabled modules on the public appointment or signup form; verify the Platform Admin appointment shows friendly names. Unknown and disabled modules must be rejected.
5. Confirm published approval-policy and notification-template codes remain selectable while new codes can still be entered; roles and audit history remain unchanged.
6. Verify Reports-only, Analytics-only and notification-only tenants continue to have their independent modules with no unintended new entitlement.

## Release boundary

This is a complete **selection-first UI and server-side validation slice**, not certification of the broader banking platform. Real MongoDB, backups, provider callbacks, npm registry audit, live browser/Core Web Vitals and Contabo staging/deployment still require external evidence. No provider settlement or fabricated success is enabled.
