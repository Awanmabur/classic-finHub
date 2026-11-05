# v1.23.2 — Windows mode-bit test correction

- Avoid Unix `0600` bitmask assertions on Windows where Node reports synthetic mode values (`0o66` in the shared log).
- Preserve strict Unix checks and all platform-independent encryption, integrity, S3 retention, and recovery tests.
- No changes to financial, tenancy, auth, backup, or offsite production behavior.
- See `docs/WINDOWS_BACKUP_TEST_V1_23_2.md` for constraints.
