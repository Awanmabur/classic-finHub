# ClassicFin Hub v1.12 — Financial transaction infrastructure

- Added validated, idempotent financial intents scoped to the tenant's actual MongoDB database, active branch and single currency; exact minor units and balanced chart-of-accounts mappings are required.
- Added strict, signed internal-gateway callback and settlement envelopes, with separate signing keys, tenant-bound identity, a five-minute signing window and timing-safe verification. Neither provider callback authentication nor provider status verification is claimed to be completed for specific external providers.
- Added append-only evidence with event reference uniqueness, mismatch/conflict/unknown-reference/duplicate-settlement exception records, and independent operational resolution with an audit event. No unsupported status is promoted into a completed payment.
- Added two-evidence reconciliation: only a confirmed callback and an independently signed settlement statement can authorize an MFA-enrolled, branch-authorized reviewer other than the initiator to create a journal. Operation status, ledger journal, ledger postings and audit event share one MongoDB transaction.
- Linked reconciled journals to financial intents and blocked direct ledger reversals of those provider-reconciled entries until a separately verified external correction lifecycle exists.
- Added financial lifecycle integration script against two disposable loopback replica-set databases, bounded read-only financial doctor, index checks and release gate.
- Preserved original public pages, dashboards and stylesheet. No production provider adapter or financial posting API enabled.
