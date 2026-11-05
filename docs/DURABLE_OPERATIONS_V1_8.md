# ClassicFin Hub v1.8 — Durable background operations

## Scope and proof boundary

This release adds a **durable MongoDB outbox** for **subscription-access change email notifications only**. It retains existing role-aware EJS dashboards and extends the Super Admin navigation with **Background Operations** at `/platform/operations/queue`. Workers never act on user-entered executable commands, money movement requests, or arbitrary job types.

**Not complete:** automatic billing, real-money settlement, banking/forex transfers, invoices and accounting, provider callback reconciliation, event-driven general notification templates, externally monitored alerts, point-in-time recovery, production load/soak testing and regulatory approvals. Do not enable `REAL_MONEY_ENABLED` or present provider acceptance as email delivery.

## Transaction chain

1. Super Admin grants or revokes a subscription through an authenticated, CSRF-protected platform form.
2. Backend verifies admin authorization, tenant, published plan, seat/branch capacity and terms.
3. In **one MongoDB replica-set transaction**, the tenant subscription is updated, a platform audit event is recorded, affected staff/module grants are contracted as required, and a supported outbox event is inserted (unique key). **Any failure rolls back the entire change.**
4. The HTTP response confirms only the persisted administrative change and queued notification; it does not claim email delivery or payment collection.
5. A separate worker (`npm run worker`) polls the database. A single atomic `findOneAndUpdate` leases one item, increments its attempt counter and adds a fencing token. Multiple workers can race safely; only one will claim the event at a time.
6. The worker calls the configured Resend HTTPS API using a **stable idempotency key** across retries. A successful provider response transitions the event to `accepted` and stores the acceptance ID. This **does not prove inbox delivery**, which would require provider webhook and delivery-event verification.
7. Transient errors (timeouts, rate limits, server errors) retry with capped exponential backoff and jitter. Permanent provider rejection or a missing provider configuration dead-letters the notification. Unfinished leases are recoverable; exhausted expired leases are marked dead.
8. A Super Admin may requeue a **dead** item only with a 20–400-character justification; the requeue and audit log write atomically. This retries notification only, **not the subscription mutation**. The UI never exposes addresses, bodies or sensitive job payloads.

**Delivery semantics:** at-least-once execution. Fencing prevents old workers from overwriting a new lease, but cannot undo an email request already accepted externally. Provider-level idempotency has a retention window. A crash after an API acceptance but before the MongoDB commit can cause a later duplicate delivery, especially outside that window. Do not use the current worker to post financial ledger entries or settle funds; those require transaction-specific reconciliation and idempotent financial state transitions.

## Provisioning and startup

1. Upgrade from exact v1.7 source with the verified patch, after backing up application data and testing in staging.
2. Configure external MongoDB replica set (including transactions and secure network restrictions). On development Windows with Docker Desktop, `npm run db:dev:up` uses a local-only replica set.
3. Run `npm ci`, `npm run check`, `npm test`, `npm run indexes`. The new indexes include unique event keys, claim order, lease recovery, worker heartbeat, and TTL for *accepted* delivery metadata.
4. Ensure `RESEND_API_KEY` and `MAIL_FROM` are set and the domain is verified. The system never logs email bodies or recipient addresses. Configure `APP_URL` and all existing required session/MFA secrets as documented in earlier releases.
5. Start the web service and **a separate worker** with the exact same version/build: `npm start` and `npm run worker`; or deploy `deploy/compose.prod.yml` under controlled deployment procedures. Production Compose requires `CLASSICFIN_WORKER_ENV_FILE` in addition to `CLASSICFIN_ENV_FILE`. Use the example `deploy/worker.env.example` and provide **a different MongoDB account with access only to the platform database** (`MONGO_WORKER_URI`), plus the email provider credentials. No web session/MFA secrets are required in the worker environment. Worker has no inbound port or web healthcheck.
6. Navigate to `/platform/operations/queue` as a verified Super Admin to inspect pending, processing, provider-accepted and dead events. Check the worker heartbeat count.
7. Monitor using `npm run worker:doctor` on a trusted scheduled runner. Alert on nonzero exit (missing worker heartbeat, pending job older than five minutes past due, dead-letter items, expired leases). Use your external monitoring system to implement paging. This command is **read only**, not a background scheduler itself.

Do not mount developer MongoDB credentials or `.env` files in a public web root. Never commit production secrets.

## Failure and recovery walkthrough

| Scenario | Behavior | Safe response |
|---|---|---|
| Web process dies after transaction | Event remains persisted | Worker proceeds independently |
| Database loses writable primary | Web becomes unready; worker cannot commit claims | Restore healthy MongoDB replica set; verify transaction safety before resuming |
| Worker process dies during delivery | Lease expires; another worker may retry | Check provider receipt and duplicate risk before manual dead-letter redrive |
| Email provider 429/5xx | Event retries with bounded backoff | Investigate rate limit, monitor backlog |
| Invalid recipient / missing credentials | Event dead-letters without falsely marking delivery | Repair configuration or recipient via approved procedure; requeue with audit reason |
| All retries exhausted | Expired/failed item becomes dead | Super Admin reviews failure, retries only after correction |
| Multiple workers compete | Atomic lease prevents simultaneous ownership | Scale workers with bounded concurrency; monitor MongoDB load |
| Provider accepted email, database ACK lost | Email might be resent | Rely on provider idempotency where valid; avoid exactly-once claims |

## Security and performance constraints

- Separate least-privilege workers from public HTTP; no worker ports exposed. Production worker refuses startup without its own `MONGO_WORKER_URI`. Restrict this MongoDB account to the platform database, and limit it to collections/operations required for the queue and heartbeat. Do not reuse the web app database user.
- Event types are allowlisted (`subscription.granted`, `subscription.revoked`), payloads are constrained, and each enqueue requires an active MongoDB session.
- Job payloads must never include passwords, reset links, invitation tokens, full payment details or unredacted financial transaction data.
- The queue uses indexed status/availability/lease queries; accepted metadata is eligible for TTL deletion after 90 days. Dead-letter items are retained for operator investigation.
- Worker processes one bounded email API request at a time; scale by adding replicas and measure memory, MongoDB latency and provider throughput before increasing concurrency.
- Notification data is not the compliance audit log. Preserve platform and tenant audit log retention and off-platform security logging separately.
- Logs contain event type, state and random event keys; not recipient data. Use safe access controls to prevent unauthorized job exploration.

## Verification commands

```bash
npm ci
npm run check
npm test
npm run perf:assets
npm run db:dev:up
npm run indexes
npm run outbox:integration   # localhost-only destructive scratch database
npm run worker              # separate process; requires working database
npm run worker:doctor       # independent read-only health probe
npm audit --audit-level=moderate
```

`npm run release:gate` additionally includes the local integration probe and the online npm audit. The GitHub Actions verification workflow now provisions an isolated replica set and runs this gate; it will not pass while npm advisories remain or when the database tests fail. **A source test pass is not equivalent to production verification.** The scratch probe checks atomic writes/rollbacks, uniqueness, worker competition, retry schedule, provider acceptance (with a stub), lease fencing and audited dead-letter recovery. It does not send real email or load-test Contabo.

## Infrastructure remaining before declaring the platform foundation complete

- Successful online dependency audit and dependency patch review
- Real MongoDB primary failover exercises, restore/PITR drills, retention policies, least-privilege database users, safe migrations and rollback rehearsal
- Resend delivery webhook validation and real provider live-send/rejection tests
- External monitor configuration, paging/alert acknowledgment, runbooks and incident drills
- CI staging MongoDB integration and recovery evidence; constrained load and soak tests
- Billing invoices and payment lifecycle (when authorized)
- Ledger design, financial posting, provider settlement, reconciliation, replay handling and reversals before any real money movement

These are explicit release gates, not hidden TODOs or simulated functionality.
