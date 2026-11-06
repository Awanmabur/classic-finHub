# ClassicFin Hub v1.18 — Forex independent module

> Historical request-only release notes. The current reviewed manual funds workflow is documented in [Manual funds and UI](MANUAL_FUNDS_AND_UI.md); provider execution remains a separate integration.

## Boundaries

Forex is a separately subscribable **indicative rate and quote operations** module. It is not an FX brokerage, currency wallet, cash-trading ledger, trade execution facility, or settlement product. Internal approval does not establish external market rates or actual bank/cash delivery. No financial ledger posting is made by Forex quotation operations.

The user keeps the approved dashboard styling. Forex uses the same login, MFA for privileged reviewers, tenant database isolation, branch restrictions, fixed roles, subscription grants, usage quotas, audit logging, CSRF and throttle middleware as other independent modules.

## End-to-end internal workflow

1. Platform Admin grants Forex as a standalone subscription (or a plan includes it); Tenant Owner assigns Forex to a staff member or invites a Forex Operator, restricted to their branch.
2. Authorized operator proposes a currency-pair rate with justification and validity window. The branch must be active; its cash accounting currency does not restrict indicative FX quotation pairs. Rates are indicative until independently approved.
3. Tenant Owner, Branch Manager or Reconciliation Officer with Forex assignment approves or rejects the proposed rate. No self-approval. One active rate per branch and directional pair is enforced with a partial unique index. Replacing a rate preserves historical versions.
4. Operator selects an active rate, records a customer reference and source amount, and creates an immutable quote. Its source/target minor-unit amounts and decimal rate are snapshotted atomically, along with an idempotency key, branch, actor, date, purpose and expiry. A quote must expire before its rate does.
5. A different authorized reviewer approves the quote **pending execution** or rejects it. The originator or Tenant Owner can cancel an undecided quote. A bounded expiry job closes overdue rates and undecided quotes.
6. Only authorized staff can inspect history or detail. Operations Reports can be subscribed to alone; when both Forex and Reports are authorized, it can aggregate Forex quotes without revealing customer references.

### Precision and supported currencies

- Supported pair currencies for quotation: UGX (zero decimals), KES, USD and EUR (two decimals).
- Source/target currency pair is directional, and equal-currency pairs are rejected. Branch cash currency is not used to restrict a quote, since no cash is exchanged.
- Rate syntax is a positive decimal with at most eight fractional digits, representing **one source major unit in target major units**.
- All conversion arithmetic uses `BigInt` fixed-point. The target is rounded once, half-up to its currency's minor unit. A quote that rounds to zero is rejected.
- This is a quotation algorithm, not an external market quote verification, spread/margin computation, official central-bank rate, or regulatory pricing opinion.

### Access control

| Role | Forex capability |
| --- | --- |
| Tenant Owner | Propose rates, initiate quotes, independently review items submitted by someone else, view tenant records |
| Branch Manager | Review proposed rates and quotes in own branch; no creation privilege |
| Forex Operator | Propose rates and create quotes in own branch; see own quotes; cannot review |
| Reconciliation Officer | Review Forex rates/quotes in assigned branch; read-only operational visibility |
| Auditor | Read-only permitted Forex scope |
| Reports Analyst | Access authorized aggregates with BOTH Forex and Reports grants; never create/approve quotes |

### Data safety

- Rates are stored separately from quotes. Quote conversion amounts and rate are immutable once recorded.
- Data changes are grouped in MongoDB multi-document transactions with an audit event. Rate approval uses conditional revision updates; idempotency and active-pair indexes reject races.
- Quotas are committed with quote creation; identical idempotent replay does not consume a second allocation.
- Branch archive checks Forex rate and quote history.
- All financial endpoints are private and POST actions require CSRF plus server-side role/module checks; nonfinancial GETs cannot mutate state.
- Approved quotes remain `approved_pending_execution`: provider adapters, verified bank/cash delivery, actual order placement, spread and liquidity checks, refunds and settlement reconciliation are deliberately outside this **internal** module release.

## Running source checks

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run perf:smoke
```

## Running real database checks (your isolated machine)

Run **only** against a disposable loopback MongoDB replica set:

```bash
npm run db:dev:up
npm run indexes
npm run forex:integration
npm run release:gate
```

`forex:integration` refuses a non-loopback address and production mode; it creates temporary tenant databases and deletes them after its checks. Its scenarios include rate approval, self-review denial, supersession, quote idempotency, rate snapshot preservation, quotas, cancellations, expiry, branch and tenant isolation, audits and reporting. `release:gate` includes Forex and still requires the existing auth, subscription, ledger, backup-adjacent and dependency checks. In this build environment, MongoDB refused the local connection and npm registry DNS failed, so these two external gates **are not passed**.

## Scheduled expiry (deployment)

Install `deploy/systemd/classicfin-forex-expiry.service` and `.timer` with your actual deployment paths, Unix account, and private environment file. Review and enable the timer with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now classicfin-forex-expiry.timer
sudo systemctl status classicfin-forex-expiry.timer
```

Unapproved and expired rates/quotes must not be treated as valid even if the timer is delayed; write-side conditions enforce expiry independently.

## Release checklist

- Back up DB and repository; apply exact v1.17 → v1.18 patch (or review and merge source changes), publish indexes, confirm access and quotas on a real tenant.
- Run real database, CSRF, authorization, cross-tenant, concurrent approval, quota, expiry, negative-path and restore tests before activation in staging.
- Verify rate-creation and quote-review UI with a real authorized tenant in a browser; validate branch restrictions and Reports-only tenant behavior.
- Run npm online audit and resolve all release-blocking advisories, production load and alert checks, backup restore and rollback drills.
- Do not enable an external execution endpoint without a provider-specific adapter, authenticated pricing and settlement evidence, liquidity and compliance controls, and regulated-partner approval where required.
