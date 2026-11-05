# ClassicFin Hub v1.17 — Independently Subscribed Banking Operations

## Release scope and financial boundary

Banking is an independently subscribable **internal banking request-management** module. It **does not** connect to banks, create bank accounts, store real bank balances, accept cash deposits on behalf of a bank, move funds, issue a bank statement, or post any settlement journal. The existing direct `deposit()` and `withdraw()` entrypoints continue to throw a 501 error. Banking account references hold only the last four account characters and operator-supplied labels; they are *not bank-verified*.

Approved requests enter `approved_pending_bank`, which is **not payment, bank acceptance, transfer execution or settlement**. Later adapters require real bank/provider onboarding, account verification, institution authentication, authorization, state-specific evidence, reconciliation, AML/KYC, refund/reversal policy and regulated-operations approval before changing any financial position.

## Technical architecture

- Shared multi-tenant platform: global identity and two-field sign-in, MFA for privileged roles, tenant DB isolation, branch fences, server-side RBAC and subscription entitlements.
- `banking` is now `recording_only` and may be granted directly on a modular workspace. Its monthly `banking_requests` quota is reserved atomically alongside the request creation and audit event, using a distinct add-on generation and UTC month; exact idempotent retries do not consume more usage.
- Tenant database models: `BankReferenceV1` (masked reference metadata, current active/archived state) and `BankingRequestV1` (immutable request/snapshot and controlled decisions). Unique `reference` and `idempotencyKey` indexes are enforced. Infrastructure doctor checks the banking idempotency index.
- A request creation transaction touches the active branch and selected account references as concurrency fences; account edits/archives cannot race the request silently. After creation, account reference changes never overwrite historical snapshots.
- `Banking Operator` role may create account references and banking requests in **only its assigned branch** and may view only its own requests; it cannot approve them. `Branch Manager` and `Reconciliation Officer` may independently review within their assigned branch. `Tenant Owner` can administer and review tenant-wide, but not self-approve. Auditors have read-only access. Reports Analysts may access source aggregates *without* banking operations permissions when independently assigned both `reports` and `banking`.
- The independent Operations Reports registry includes an aggregate-only Banking adapter. No customer names, account fragments, bank identifiers or raw review notes appear in reports/CSV. Standalone Banking works without Reports; Reports works without Banking.
- UI uses the existing dashboard templates/theme and does not modify the original CSS. All POST actions require the existing CSRF protection, role checks, module entitlement and financial action throttling.

## Lifecycle

1. Tenant Owner or Banking Operator registers branch-scoped, unverified, **masked** bank account references; only customer name, institution name, currency and last four account characters are stored. No full account number or authentication material is accepted.
2. Operator requests `deposit_request`, `withdrawal_request`, or `transfer_request` with immutable branch, account snapshots, exact minor-unit amount, reason, UUID idempotency key and 1–30-day validity. Transfer requests require a separate destination in the same branch and currency.
3. Request and audit event commit in one MongoDB multi-document transaction. Repeated exact idempotency keys return the original request; conflicting reuse is rejected. Unavailable/expired entitlements, wrong branches, archived references, invalid currency and exhausted quota block creation.
4. A separate reviewer accepts or rejects with a 12–400-character justification; self-approval and concurrent decisions fail. Accepted status is `approved_pending_bank` (never `paid`, `posted` or `settled`).
5. Pending, undecided requests may be cancelled by their originator or the tenant owner, preserving audit history.
6. Requests which remain `requested` after their expiry are automatically moved to `expired` by a bounded, audited, idempotent job. Expired requests cannot be approved even before that job runs. Approved pending bank requests are not auto-expired; future bank adapters must provide explicit bank execution/cancellation outcomes.
7. Scoped, cursor-paginated history and immutable request detail pages are available. No unverified document is labeled a bank statement or payment receipt.

## Installation and commands

Apply the exact v1.16→v1.17 patch only to a matching source tree, with local changes backed up. Alternatively inspect/merge the updated release archive. Preserve existing `.env`, database and secret files.

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up        # requires Docker Desktop, isolated local replica set
npm run indexes          # creates banking unique indexes across tenants
npm run banking:integration
npm run release:gate      # includes bank integration and online npm advisory scan
npm run banking:expiry    # bounded expiry job with authenticated platform DB access
```

Deploy the expiry timer from `deploy/systemd/classicfin-banking-expiry.{service,timer}` after adjusting service account, paths, secret permissions and monitoring. The timer only works when installed and enabled on the intended host. Monitor unsuccessful exits and large expiry backlog. Do not run integration tests on production: the integration script restricts itself to loopback and uses disposable scratch databases.

## Verified and unverified release criteria

- Source tests, EJS/JavaScript static checks, asset budgets and localhost public-route HTTP smoke were executed for this release.
- Local MongoDB integration **could not run** (`ECONNREFUSED` on 127.0.0.1:27017). Tests including transaction rollback, cross-tenant isolation, reference concurrency and quota must pass against an actual isolated replica set before approval.
- Online npm audit **could not complete** (`EAI_AGAIN` to registry.npmjs.org). Do not bypass dependency clearance for release.
- No bank/provider API, regulatory proof, customer due diligence, real settlement, bank statement, production load test, backup restore drill or deployment was verified. The financial system remains fail-closed for real money.
- Existing software modules, authentication, public SEO assets, and dashboard CSS were not deliberately modified beyond additive Banking integration and role/entitlement fixes.

## Next API handoff

User supplies the licensed bank/provider account, sandbox credentials and webhook requirements. Engineering must still implement the provider-specific adapter and secure credential management, account-verification mapping, webhook authenticity and replay protection, durable request dispatch, independently verified settlement and statement reconciliation, idempotent ledger posting, maker-checker corrections, negative tests, and operational alerting. **Adding secrets alone must not enable posting.**
