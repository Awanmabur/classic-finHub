# ClassicFin Hub v1.16.0 — Money Transfer operations

- Activated Money Transfer as an independently subscribable **request-recording** module; provider payout and legacy money-sending entrypoints still fail closed.
- Added sender/beneficiary contact management, branch-safe record permissions, immutable contact snapshots, internal transfer requests with exact minor-unit currency handling, UUID idempotency, separate subscription quota, expiry, cancellation, two-person decisions and transactional audit events.
- Added dedicated module overview, history, contact editing, request detail, and internal acknowledgement screens with the approved dashboard styling unchanged.
- Added standalone Operations Reports adapter for Money Transfer; independent Reports subscription retained.
- Added Money Transfer Operator role, branch-scoped staff delegation, report-source assignment for Reports Analysts, read-only auditor access and restricted reviewer permissions.
- Corrected the tenant resolver to allow an active standalone module grant when the base plan has expired, while keeping blocked/suspended tenants blocked.
- Added bounded expiry job and timer templates, unique indexes, infrastructure checks, integration runner, release gates and focused unit tests.
- No real payment execution, ledger settlement or provider confirmation was enabled.
