# v1.19.0 — Independent Advanced Analytics

- Activate Advanced Analytics as a standalone module with independent subscription, expiry/revocation, backend permission and menu enforcement.
- Add MFA-protected Analytics Analyst role, read-only source assignments, tenant and branch scoping.
- Reuse Operations Reports aggregate adapters without requiring a Reports entitlement; do not create competing reporting data.
- Compare 7, 14 or 30 fully completed UTC days against the equal preceding period, plus authorized workspace daily event trends.
- Add accessible card/table dashboard, source/date controls and spreadsheet-safe aggregate CSV export under existing dashboard design.
- Bound expensive queries with database-coordinated per-user and per-tenant rate limits; no-store private responses.
- Explicitly exclude unverified revenues, profit, balances and settlement claims; no synthetic data.
- Add automated regressions and isolated MongoDB integration scenario to release gate.

See `docs/ADVANCED_ANALYTICS_V1_19.md` for exact scope, operational setup and outstanding release evidence.
