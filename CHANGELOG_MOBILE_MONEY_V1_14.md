# ClassicFin Hub v1.14 — Mobile Money operational case management

Date: 2026-11-03. Upgrade from v1.13; no redesign of the original dashboard or marketing UI.

## Delivered in source

- Independent Mobile Money subscription gates and previously implemented recording/review workflows are retained.
- Operators can request corrections to their own as-yet-unverified operational records, with explanation and no silent edits.
- Independently authorized tenant owners or reconciliation officers can approve or deny a request only if they did not originate it, with branch-scoped access for officers.
- Atomic MongoDB updates and tenant audit events; original amount, fee, currency, network reference and operator are retained.
- Approved corrections result in `voided_internal`, explicitly not a provider refund/settlement or ledger posting. Denied corrections may be re-requested, subject to a five-request cap.
- Chronological immutable-by-application correction history preserved through denial/re-request; no deleted rows, refunded balances, or implied provider confirmation.
- Normal internal-review queue excludes records awaiting a correction decision, preventing conflicting workflows.
- Branch- and operator-scoped Mobile Money history with stable keyset pagination, custom date ranges and record details.
- Restricted correction notes for read-only Viewer role; report adapters and CSV include correction state with unambiguous operational-status labels.
- The reporting hub is still independently subscribable and cannot grant access to Mobile Money operations.
- Additional integration-script scenarios and 10 new automated regression tests, preserving all previous tests.

## Non-completed external obligations

No real provider integrations were added; they require an agreed provider API and sandbox/live credentials. The internal correction process cannot reverse provider payments. A provider-specific adapter must validate independent provider evidence, callbacks, settlement reports and reconciliation before the shared ledger can post money movements.

Source-only test results cannot certify production behavior: real MongoDB tests, provider sandbox, external audit, TLS/edge, offsite restoration, load, production monitoring and dependency audit are separate required gates.
