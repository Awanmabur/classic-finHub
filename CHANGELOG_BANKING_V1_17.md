# ClassicFin Hub v1.17 — Banking Operations

- Activated Banking as an independent `recording_only` module with standalone grants and a metered monthly quota.
- Replaced the empty Banking route and unavailable internal operation service with tenant-database-backed masked references, requests, second-person decisions, cancellation, expiry, history and scope-restricted views.
- Preserved fail-closed direct bank deposit/withdrawal and external settlement behavior.
- Added Banking Operator role to invitations, permission mapping and branch management; corrected older missing invited-role enums for Money Transfer and Reports Analyst.
- Added banking aggregate-only adapter to standalone Operations Reports; banking usage to tenant billing, and Banking activity to the role-based overview.
- Fenced account-reference changes against concurrently created requests, added required banking indexes to the infrastructure diagnostic, and prevented archiving branches with banking request history.
- Added local-only banking integration script, 15-minute expiry timer template, source tests and documented provider handoff.
- No original dashboard stylesheets or public asset optimizations changed.
