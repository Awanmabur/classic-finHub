# ClassicFin Hub v1.18 — Independent Forex Quotation Operations

- Added an independently subscribable Forex module, reusing tenant identity, branch isolation, roles, usage billing, durable audit records, and the established dashboard design.
- Built tenant-database schemas for indicative rate proposals and immutable customer quotes. Each rate requires a different authorized reviewer; each quote has a separate independent review.
- Added exact fixed-point exchange-rate mathematics, integer minor-unit amounts, currency-specific precision, explicit rounding, rate snapshots, idempotency, and per-module monthly quote quotas.
- Added rate supersession and expiry, quote cancellation/rejection/expiry, and automatic bounded expiry sweeps with systemd templates.
- Added Forex Operator role, branch-scoped staff administration, independent reporting-source authorization, Forex-only tenant overview cards, billing meters, and CSV-compatible aggregate reports.
- Preserved `buy` and `sell` fail-closed: real execution, currency inventory, settlement, customer funds, and profit/loss are **not** simulated.
- Added tests for entitlements, currency arithmetic, input validation, immutable snapshots, security, EJS escaping, reporting, and expiry; added localhost-only real-MongoDB integration test to the release gate.
- Removed unused Forex controller and Joi placeholder validator; active routes exclusively use the new transaction-safe service.

## External release gates

Real MongoDB replica-set integration, npm advisory scan, live provider execution, and production infrastructure are not verified by the source-only test run. An internal quote approval is not a completed trade.
