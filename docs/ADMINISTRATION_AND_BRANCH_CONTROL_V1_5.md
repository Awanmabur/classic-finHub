# ClassicFin Hub v1.5.0 — Platform and Tenant Administration

**Release date:** November 3, 2026. **Base:** exact packaged v1.4.0. **Design:** existing dashboard CSS and two-field email/password login preserved. This release completes a bounded administration workflow; **it is not a certification for real-money operation**.

## Implemented and connected end-to-end

- **Super Admin/platform:** Live platform tenant counts, active/suspended counts, recent tenant records, and 100 latest platform audit events. Privileged actions remain behind the existing Super Admin email/password and mandatory MFA. Create a tenant with controlled owner invitation; change tenant status through a validated transition and mandatory 12–400 character reason; edit tenant display name/phone with an audit record. Each change is MongoDB transactional. No ability to bypass subscriptions, manually alter pricing, take over credentials, or rewrite financial history.
- **Tenant Owner:** Create a branch (unique code, name, UGX/KES currency, address), rename/update address, archive an eligible branch, and restore archived branches. Active branch count is enforced atomically against the subscription in the platform Tenant record. The tenant database holds indexed branch documents. Archiving refuses branches with active assigned staff, pending invitations, or unverified records; historical transactions and audit logs are never deleted. Currency is immutable after creation.
- **Staff:** Create single-use 24-hour invitations tied to an active branch, an allowed role, and selected live modules. Accepting the invitation requires a unique globally resolvable email and strong password; seats are reserved transactionally. Tenant Owners can edit staff name, role, branch, and module subset; disable and restore accounts; cancel pending invites. Role/branch/module edits increment `authVersion` to invalidate sessions; restoration checks the plan seat limit. Disabled accounts can be reassigned before restoration.
- **RBAC and entitlements:** The server fixes all role capabilities. Module assignment is a *restriction*, never a privilege escalation. A user must have the module assigned, the tenant must subscribe to it under the plan, and the role must have the operation permission. Tenant Owners see all permitted subscribed modules. Branch Managers require MFA and are branch-scoped; they cannot invite staff or approve financial reviews. Operator, Reviewer, Auditor, and Viewer scopes remain distinct.
- **Mobile Money:** New operational records are attached to an active branch in the user's tenant. Staff branch identity comes from the signed-in account, not the request payload. Owners explicitly select a branch. Branch currency must match the record. Operators see only their own branch records; managers/reviewers can see their branch subject to permission; auditors and owners can oversee their tenant. A branch-scoped reviewer cannot approve another branch's record. No record creates provider settlement or financial balances.
- **Audit:** Staff/branch operations and their audit events are in one MongoDB transaction. Platform status/profile and tenant-creation operations record platform audit entries in their respective transactions. Both dashboards have actual, permission-protected audit pages. Indexes cover branch queries, financial branch views, and audit timelines.

### System boundaries

- **Owner email changes:** Cannot be performed by editing a tenant profile. Email is an immutable key in the global login directory, so it requires a dedicated identity-reassignment workflow with verified possession and audit.
- **Financial correction:** Never edit immutable transaction amounts, provider references, settlement history, or audit entries in place. Use a future controlled reversal/correction flow with a second approver and separate ledger entries.
- **Pricing and plan changes:** Read-only catalogue is retained. Subscription changes must be committed through a versioned billing change process, not by arbitrarily changing tenant fields.
- **Invitations:** This release displays a private activation URL once; no automatic invitation email delivery is claimed. Share the URL through a trusted channel. Password-recovery email uses the separately configured provider.

## Existing installation: safe upgrade requirements

1. Back up MongoDB platform and each tenant database and verify a restore on an isolated instance. Commit local Git changes and review the patch before applying. Ensure v1.4.0 exactly matches the patch base.
2. Apply v1.5.0. Keep existing production `.env`, MongoDB data, and MFA encryption key unchanged.
3. Run `npm ci`, `npm run check`, `npm test`, `npm run indexes`. All financial operations require MongoDB replica set transactions.
4. **Existing tenants:** Their prior application has no secure Branch collection. A missing `branchCount` is treated as zero for first creation; subsequent branch operations use the atomic counter. Do not modify the count manually without first reconciling it with existing active branch rows.
5. **Existing tenant staff:** If branch assignment is missing, new Mobile Money recording is refused until the Owner creates a branch and assigns that staff member to it. Changes revoke their prior sessions. Legacy role-based module access is retained until a member is explicitly edited; after editing, only the assigned module subset applies. Review all legacy role permissions before launch.
6. **Legacy pending staff invitations:** Old invitations without a branch cannot be activated. Revoke them and reissue with an active branch and explicit module permissions.
7. **Historical transactions:** Older records may have no branchId. They are **not** automatically attributed to a branch: current staff assignment is not proof of historical branch membership. Tenant Owners/Auditors can view older tenant-wide records; branch-limited users should not be automatically given access to them. Decide and approve a documented reconciliation/migration case by case.
8. Require MFA for newly added Branch Managers. Re-test tenant-admin login, branch creation, role reassignment, module denials, audit write, archive preconditions, and account restoration.

## Developer commands (Windows Git Bash / Docker Desktop)

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run perf:smoke
npm run db:dev:up
npm run db:doctor
npm run indexes
npm run auth:integration
npm run review:integration
npm run admin:integration
npm run db:integration
npm audit --audit-level=high
```

The integration scripts refuse `NODE_ENV=production` and non-loopback MongoDB. Do not run against live data. The local MongoDB scripts require a real replica set and are not simulated in source tests.

## Release gates still open

1. Real local database admin integration, HTTP login integration, review integration, and an independent production-like staging test must run against a replica set; this editing environment has neither MongoDB nor Docker.
2. npm audit must complete successfully against an accessible advisory registry. This environment did not clear the previous reported vulnerabilities.
3. Successful real email delivery, production hardening, database backups and recovery drills, HA/restore/monitoring tests, multi-tenant load/stress and penetration testing are still mandatory.
4. Payment providers, authoritative settlement callbacks, balanced immutable ledger, disputes, reversals, funds reconciliation, and financial operating approvals must be implemented and independently verified before real money movement.
5. Public SEO/AI crawler configuration from v1.3 is preserved. Production indexing, structured-data validation, and Core Web Vitals need live-site verification; private dashboards must remain noindexed.

**No deployment or Git remote push is performed by this archive.**
