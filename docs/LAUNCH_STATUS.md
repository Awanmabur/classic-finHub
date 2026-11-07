# Launch candidate status — 7 November 2026

Version 1.24.0 is the prepared launch candidate. The repository contains immutable-image deployment/rollback, a TLS proxy template, separate workers, protected environment templates, backup/offsite/restore tooling, timers and a read-only `production:check` command. Follow [LAUNCH_RUNBOOK.md](LAUNCH_RUNBOOK.md) in order.

| Area | Evidence state |
| --- | --- |
| Repository unit, isolated database and browser checks | Passed: 402 JavaScript tests, 13 Android relay tests, 477 JS/EJS syntax/template checks, all registered isolated Mongo integrations, and zero dependency vulnerabilities. [Latest transfer/Workspace evidence](review/transfer-workspace-operations/README.md); [earlier launch evidence](review/launch-1.24.0/README.md). |
| Production configuration probe | Implemented and regression-tested; configuration-only mode cannot claim live readiness. |
| Outbox/notification health | Correct worker classes are checked separately; a notification worker cannot mask a failed outbox worker. |
| Immutable release and rollback | Tested with controlled deployment doubles, including failed readiness and failed pull. No actual public deployment was performed. |
| Production image build and isolated startup | Earlier candidate image passed actual Dockerfile/lockfile build and startup: Node 22.23.4, non-root, read-only rootfs, dropped capabilities, ready/home 200 and private 303/no-store/noindex. Rebuild an immutable image from the final source commit before deployment; the earlier image predates the latest transfer/Workspace changes. This does not validate a live host. |
| Actual production hostname, DNS, TLS, proxy and cookies | Not supplied/validated in this cloud session. |
| Authenticated production replica set, service roles and firewall | Not supplied/validated; local replica-set tests do not prove deployment permissions. |
| Live recovery email and Android/provider message delivery | Not demonstrated on production bindings. |
| Encrypted offsite backup, independent alert reception, real restore/PITR and measured RPO/RTO | Not demonstrated on the production environment. |
| Production capacity, third-party penetration testing and business/financial operating acceptance | Not established by local tests. |

The application supports the implemented manual financial books and configured SMS capture. Live provider balance/settlement APIs, automatic payment collection/invoicing and other explicitly unavailable features remain separate work; keep `REAL_MONEY_ENABLED=false`. Public crawler access does not guarantee search indexing or AI inclusion.

Do not describe this candidate as “100% production verified” until the actual host, recovery, delivery, access and operating evidence is complete. The read-only probe deliberately reports those remaining requirements instead of silently approving them.
