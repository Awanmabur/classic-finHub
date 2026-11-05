# v1.22 — Selection-first usability and cross-module consistency

- Money Transfer: select from named ISO country options for create/edit; server rejects non-country codes. No country is silently preselected for new contacts.
- Banking: reuse previously saved tenant-and-branch-scoped institution names from a selector, or explicitly enter a new one; backend checks the selected name against the permitted scoped directory.
- Money Transfer, Banking, Forex and Approvals: bounded validity times become selectable; approval rules retain custom 1–720 hour support.
- Transfer/Banking request currency is derived from the selected branch; Mobile Money branch choice sets matching currency in the browser, always rechecked server-side.
- Public appointment/signup requests: select multiple independently available modules, not a forced bundle or free-form text. Only known active module keys are accepted; cached legacy bundle labels are translated safely.
- Platform appointments: display human-readable module names.
- Policy and notification template forms: suggest existing versioned codes to reduce repetition.
- Preserved existing two-field login, tenant/branch permissions, subscriptions, audit trails, reports, analytics, and dashboard CSS.
- Added 9 source-focused tests in selection-first.test.js.

No live provider execution, settlement, or schema migration is introduced.
