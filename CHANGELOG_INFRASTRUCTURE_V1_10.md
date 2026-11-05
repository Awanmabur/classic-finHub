# ClassicFin Hub v1.10.0 — Offsite immutable recovery and operational alerts

- Preserve all approved platform/tenant/branch dashboards and existing authentication / role enforcement.
- Add AWS S3 Object Lock COMPLIANCE upload using fixed regional HTTPS endpoints and a dedicated IAM role.
- Require bucket versioning, Object Lock, checksum, encryption, retention, version ID and verified encrypted archive before writing a private receipt.
- Make a re-run verify the existing remote version, never silently upload a duplicate when an independently verified receipt exists.
- Add exact-version offsite download that verifies ciphertext SHA-256 and AES-GCM before publishing a recovery artifact; never auto-restore into the live database.
- Add 4-hourly local/offsite backup freshness checks and a heartbeat to an independently configured external monitoring receiver.
- Send sanitized failure alerts via a token-authenticated HTTPS webhook; no customer or financial record data in alert payload.
- Add hardened systemd backup, monitoring and failure handlers, private configuration templates and an incident runbook.
- Expand source tests with offsite checksum, lock, retries, recovery tampering, stale checks and alert handling.
- Operational release gates remain unverified for real AWS S3, backup restore, MongoDB, provider delivery, live load and npm registry scan.
