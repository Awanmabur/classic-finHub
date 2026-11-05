# ClassicFin Hub v1.11.0 — 3 November 2026

- Introduced isolated, append-only tenant chart-of-accounts, journals and postings.
- Added exact minor-unit and per-currency debit/credit balancing, source replay detection, MongoDB-transactional posting and audit.
- Added independent approval of exact-offset reversal journals, with unique reversal protection and original-entry preservation.
- Added bounded trial balance, journal integrity verification and a read-only tenant ledger diagnostic.
- Hardened branch archiving against ledger history and posting/archival concurrency.
- Extended tenant unique-index diagnostics, staging release checks and scratch-only integration coverage.
- Preserved existing dashboards, CSS, SEO, email/password login, MFA, subscriptions, backup and worker systems.

**Not a real-money release:** provider verification, settlement, reconciliation, overdraft policies and customer-facing balances remain disabled. Live MongoDB and npm vulnerability checks still require execution before any production approval.
