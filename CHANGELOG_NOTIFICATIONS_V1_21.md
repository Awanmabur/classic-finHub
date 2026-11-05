# ClassicFin Hub v1.21.0 — Independent Notifications

- Enabled standalone Notifications subscription in the existing module catalogue and enforced user/branch-scoped access.
- Added tenant-database notification templates (immutable versions), private staff inboxes, read markers, email preferences, audit events and authorized message sending.
- Added separate notification email worker using bounded leases, deterministic idempotency, retry/dead-letter/suppression and provider-accepted status. Added independent worker credentials, startup and heartbeat controls to production Compose and rollout.
- Added audited owner-only dead-letter recovery and privileged operational logs.
- Added optional Approval Workflows decision notices and independently entitled aggregate Reports/Analytics source.
- Added local-only MongoDB integration scenario, focused unit tests, monitoring script and documentation.
- Preserved the original dashboard stylesheet and the existing financial safety boundaries. No fake SMS, settled funds or delivered-email claims.
- External verification still required: MongoDB replica set, online npm audit, real Resend acceptance, production mail delivery, backup/restore, deployment and security review.
