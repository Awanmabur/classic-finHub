# ClassicFin Hub v1.20 — Approval Workflows

## 1. Scope and essential security boundary

This is a **standalone internal authorization-request module**. It can be purchased and used without Mobile Money, Money Transfer, Banking, Forex, Operations Reports or Analytics. It does not own money or execute real-world changes. In particular:

- Approving a procurement or operational-exception request **does not release money, reverse a settled ledger entry, execute a bank transfer, change a tenant subscription or automatically change another module's record**.
- The existing financial-module review gates remain mandatory, regardless of this add-on's subscription status or the outcome of an internal request.
- This design prevents an independently configurable workflow from silently weakening mandatory financial controls. Integrating an automated action executor in the future requires a separately designed authorized command adapter, explicit policy mapping, unique operation key, failure recovery, and per-module security tests.

## 2. Operating model

The **Tenant Owner** publishes an approval policy, giving it a unique code, name, category, 1–3 ordered reviewer *roles*, and deadline in hours. Republishing the same code creates a new immutable policy version; already-submitted requests retain their earlier steps. A policy can be retired without deleting its records.

The **Approval Requester** or another authorized staff member submits an internal business request tied to their actual branch. A Tenant Owner selects an active branch. An opaque idempotency key prevents a double submission. The first reviewer must belong to the exact configured role, hold an active individual module assignment and be authorized to access the branch. Reviewers cannot approve their own request or participate twice in the same approval chain. Each accepted stage moves to the next; rejection terminates the request. The request expires by a background sweeper; cancelled, expired, rejected and approved requests retain audit evidence.

A staff member's module grant cannot add financial permissions. Disabling a user, revoking the module or changing assigned permissions closes their access by existing shared session and backend entitlement checks. Historical decisions are not erased.

Supported categories are `general`, `procurement`, `operational_exception` and `policy_change`. These categories label internal records only; they do not provide automatic execution.

## 3. Role and branch permissions

| Role | Supported actions |
| --- | --- |
| Tenant Owner | Publish/retire policies, submit, read tenant-wide, act as configured owner-stage reviewer (never own request) |
| Approval Requester | Submit and view their own branch requests; cancel their own pending requests |
| Approval Officer | Submit, view branch requests, approve only an assigned Approval Officer stage; MFA mandatory |
| Branch Manager | Submit/review assigned-branch requests only if configured as a stage, invite branch requesters, no authority to publish policies or assign an Approval Officer role |
| Reconciliation Officer | Submit/review as configured, within assigned branch; existing financial permissions remain separate |
| Auditor | Read permitted requests, never decide |
| Reports/Analytics Analyst | Only separately assigned aggregate data, no request detail or approval authority |

A Tenant Owner may not delegate platform-administrator privileges. A Branch Manager cannot grant review privileges to requesters, and changing browser parameters cannot enlarge branch scope.

## 4. Routes and database

- `GET /tenant/approvals` — policy selection, request creation, queue, bounded history and policy publication for owners.
- `POST /tenant/approvals/policies` — controlled policy publication (new version).
- `POST /tenant/approvals/policies/:code/retire` — retire active version.
- `POST /tenant/approvals/requests` — idempotent request.
- `GET /tenant/approvals/:id` — scoped case record, decisions and available actions.
- `POST /tenant/approvals/:id/decide` and `.../cancel` — transactionally enforced state transitions.

`ApprovalPolicyV1` and `ApprovalRequestV1` collections reside only inside each tenant's database. Critical indexes include `code+version` uniqueness, one active policy per code, `idempotencyKey` and `reference` uniqueness, and branch/status/expiry indexes. Audit events are written in the same transaction as decisions; request data and policy snapshots are immutable. A branch with pending approval requests cannot be archived.

GET pages remain noindex/private; POSTs use the application's shared CSRF validation and distributed financial-action throttling. Tenant role and subscription checks are enforced on the server, not only in EJS.

## 5. Reporting independence

The standalone Operations Reports registry includes an optional `approval_workflows` adapter, exposing **only aggregate category and status counts**, never names, subject descriptions, notes, reviewer IDs or customer data. The shared Analytics module can use the same authorized aggregate data without a Reports subscription. Each module's entitlement and the current analyst's explicit source assignment must both be present. An analyst cannot approve any request.

## 6. Local verification and release gate

Starting from exact v1.19, save local changes, apply the version patch and run:

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up
npm run indexes
npm run approval:integration
npm run release:gate
```

The integration test intentionally uses disposable tenant databases under an isolated **localhost MongoDB replica set** and rejects production or remote cluster URLs. It verifies versioning, replays, decisions, expiry, tenant isolation, reports and audit records.

Scheduled expiry uses `npm run approval:expiry` and `deploy/systemd/classicfin-approval-expiry.{service,timer}`. Install only after confirming `WorkingDirectory`, secrets file, runtime paths and service user for your actual host. Use an external monitor for failed or missing runs; the timer alone is not proof of reliable execution.

Run live staging tests for concurrent decisions and deployments, check staff invitations and MFA in a real browser, and inspect audit events after role/module revocation. Configure retention, backup/restore procedures and permissions for approval records before processing real customer business information.

## 7. Outstanding release gates

The source tests do not replace MongoDB integration, staging review, online npm security audit, measured load testing or a backup restore drill. No production certification, Git push or deployment is represented by this archive. The module requires **no external provider API** for its bounded internal approval function. Automated execution of financial actions is intentionally not part of this product.
