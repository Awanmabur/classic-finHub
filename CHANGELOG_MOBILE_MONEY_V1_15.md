# ClassicFin Hub v1.15 — Cash operations and internal acknowledgements

- Added secure branch/operator cash-shift model, indexes, scope, cursor history, and audited state machine.
- Added independent opening-cash verification; rejected openings cannot accept records.
- Bound new Mobile Money operational records to one verified open shift atomically with quota reservation, transaction and audit.
- Required independent internal review/void before shift submission, with cash-out provisional coverage checking.
- Added counted close, source-record movement reaggregation, discrepancy evidence, independent close approval/dispute and resubmission history.
- Restricted nonzero-variance approvals to Tenant Owners/Reconciliation Officers; Branch Managers can dispute or approve exact counts.
- Added branch-filtered cash-shift pages and printable **non-settlement** operational acknowledgements.
- Added optional `cash_shifts` reporting source to independently subscribed Operations Reports.
- Replaced old fake cash-drawer/day-session and unusable receipt service placeholders with real workflows.
- Removed hard-coded inactive branch/currency dropdowns from the active dashboard header while preserving the existing dashboard stylesheet.
- Added source and disposable-local-MongoDB integration checks and read-only index diagnostics.
- Did not enable real funds movement, provider float, or settlement.
