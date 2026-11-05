# v1.20.0 — Independent Approval Workflows

- Implement standalone approval-request management with an independently assigned subscription and role-based access.
- Add Approval Requester and MFA-protected Approval Officer roles. Branch Managers may invite requesters in their own branch, but cannot grant approver status.
- Versioned tenant approval policies with one to three ordered reviewer roles, a bounded deadline, and immutable request snapshots.
- Tenant- and branch-scoped request creation with opaque idempotency keys, active-branch fencing, and transactional audit writes.
- Two-person and multi-stage decisions; exact reviewer role, branch and module entitlement enforced server-side; current-step revision fencing prevents competing approvals.
- Immutable original request fields, chronological reviewer evidence, revocation-safe access checks, controlled cancellation and audited expiration.
- Existing dashboard cards/forms/navigation retained; Approval-only tenants see relevant requests on their Overview.
- Operations Reports and Advanced Analytics may read aggregate approval counts as *independently authorized sources*, with no decision privileges granted to analysts.
- Add scheduled expiry job, scoped index checks, 9 focused tests and isolated two-tenant MongoDB integration scenario.
- Approval is explicitly **an internal decision only**. It does not execute finance operations or bypass the required existing financial review flows.

Release evidence needed: real MongoDB replica-set integration, online npm audit, production rollback/backup drill and staging authorization tests. No deployment or external provider transactions were performed.
