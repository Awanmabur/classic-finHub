# ClassicFin Hub v1.13 — Independently subscribed modules and Operations Reports

## Decision and scope

The existing modular monolith, original dashboard stylesheet, platform/tenant databases, unified email/password login, MFA and role-based dashboards are retained. The two available independently activated modules are:

- **Mobile Money** — tenant/branch-scoped recording, independent second-person review, audit events and bounded monthly recording quota. Status is `recording_only` until real provider adapters, licensed settlement and reconciliation are verified.
- **Operations Reports** — independently licensed reporting workspace, date/source filters, tenant/branch data scopes and formula-safe CSV exports. It does **not** require Mobile Money. Its built-in workspace audit summary works when no operational module is assigned. A Mobile Money report source appears only if its own entitlement and user assignment are both present.

Other operational products remain intentionally disabled, not simulated. Future modules add an implementation and a reporting adapter rather than copying the Reports code.

## Commercial model

An initial **Modular Workspace** is a new plan with no functional operational modules. A tenant can activate one independent module, both, or neither. Existing, published plan version payloads were not changed. New modules use separately recorded `moduleGrants` with an expiry, price snapshot, monthly recording quota and user/branch limits. Prices are indicative and a manual grant is **not** a paid invoice. No user-entered prices or arbitrary modules are accepted.

### Activation and revocation lifecycle

1. Tenant Owner opens **Tenant → Modules** and submits a reasoned request.
2. A pending request is uniquely recorded for `(tenant, module)` in the platform DB with an audit entry; multiple open duplicates are rejected.
3. Super Admin opens **Platform → Module Requests** or the tenant detail view and reviews the request and agreement. A manual grant/renewal requires a term, limits and a 20–600 character justification.
4. The grant is committed transactionally with an audit entry; matching pending requests are marked approved in the same transaction. The tenant gains access only while the module term and tenant status remain valid. Staff assignment and role permission are still required.
5. A revocation immediately removes the entitlement, contracts active staff and pending-invitation module assignments when the module is not also included in the active base plan, and revokes affected login sessions by increasing their auth versions. A future grant does not automatically reassign those staff modules.
6. A denial is separately audited; an approved request does not claim payment receipt or provider settlement.

Base-plan renewals and standalone-module renewals use distinct quota generations. A same-module extension preserves the current generation so customers cannot renew repeatedly just to reset monthly usage. Module quotas are counted in the same database transaction as recorded operations. The effective workspace seat/branch limit is the maximum of the active base plan and active individual grants, not the sum.

### Existing tenant upgrade

No destructive data migration is required for pre-v1.13 tenants. Mongoose defaults empty `moduleGrants` when absent. Existing subscriptions and their locked price/plan versions remain untouched. Historical `reports` strings from the original trial plan did not automatically grant the new first-class Reports product to already persisted tenant snapshots; they need an explicit audited module grant or an authorized new published plan version.

Run `npm run catalog:publish -- --apply` once against a secured replica-set environment to publish the new Modular Workspace. Existing plan records retain their original checksums. Review pre-existing staff role/module assignments before granting an independent module.

## Reporting adapter contract

Reporting modules implement an adapter and register it in `src/tenant/reporting/registry.js`:

```js
{
  key: 'my_module',
  label: 'My Module',
  moduleKey: 'my_module',
  async rows({conn, tenant, user, filters, dateRange, scope}) {
    return [{module:'My Module', activity:'...', status:'recorded',
      currency:'—', count:1, volume:'—', fees:'—'}];
  }
}
```

The aggregate reporting engine checks `reports.view`, the Reports module entitlement and staff assignment. Each optional data-source adapter is *also* gated by that source module's entitlement and staff assignment, without granting its transaction permissions. Role `Reports Analyst` may be assigned data-source visibility without receiving Mobile Money posting or review rights. Staff without tenant-wide privileges are branch-scoped. CSV contains aggregate rows only; no customer names, email addresses or provider references.

**No magic zero-dependency reporting exists for future modules.** Each future module still needs its own production-grade adapter and tests. The Reports core does not need to be rebuilt for the module.

## Testing and launch boundaries

Verified in this environment: unit/security regression suite, JS/EJS syntax checks, existing public-route smoke tests, asset budgets, and archive/patch verification. The `module:integration` script exercises a disposable pair of locally isolated tenant databases, manual module requests, grants, independent reporting, quota exhaustion, module revocation, and cross-tenant separation. It *must* pass before staging approval; localhost-only protections prohibit production targets.

The following cannot be certified without user-provided infrastructure and authorized providers: live MongoDB replica-set integration, npm online audit, real email/provider delivery, payment collection and invoicing, network settlement/reconciliation, backup restore and staging/Contabo deployment. **A placeholder API key is never a completed provider integration.** Even after the user supplies keys, provider callbacks, signature validation, reconciliation, failure recovery and accounting evidence require live tests.

### Local verification

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up
npm run indexes
npm run catalog:publish -- --apply
npm run module:integration
npm run release:gate
```

Use isolated local database and never run destructive tests against production. Ensure status, users, tenant data, plan and addon terms are backed up before applying any migration or deployment.

## UI preservation

The approved `public/css/dashboard.css` is unchanged. New forms and cards use its existing classes. There is no role selector on the login form; post-login dashboards still derive from server-verified account identity, tenant, role and module assignments.
