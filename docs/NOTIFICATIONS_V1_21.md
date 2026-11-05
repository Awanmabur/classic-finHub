# ClassicFin Hub v1.21 — Independent Notifications module

**Scope:** Existing v1.20 UI, tenancy, authentication, plans, module grants, audit and financial controls are preserved. This is a standalone, independently subscribable module, and neither Operations Reports nor Approval Workflows is required for its core inbox, templates or message workflow.

## What is operational in source

- Explicit `notifications` module grant and per-user assignment, enforced in middleware **and** services. Users only see their own inbox and cannot read a message by guessing an identifier.
- Tenant Owner publishes and retires **versioned plain-text templates**; new versions preserve messages already created. Only three allowlisted variables are substituted: `recipient_name`, `tenant_name`, `sender_name`.
- Tenant Owner and Branch Manager can send to authorized active recipients. Branch Managers may reach only manageable staff in their own branch; only Tenant Owner can send tenant-wide. One recipient per request, with a shared tenant/user rate budget and idempotency key.
- `NotificationMessageV1` records are committed with an audit event inside a MongoDB transaction. Sender identity, recipient identity, branch, immutable template/version snapshot, inbox read state and accepted/retry/dead-letter state are persisted in each **tenant database**. Essential password/reset/MFA communications remain **platform security** functions, not a paid add-on.
- Optional registered-email delivery requires **recipient opt-in** and a template that permits email. The separate notification worker fetches the current recipient status, assignment and preference **immediately before sending**. Disabling a recipient, revoking the module, or opting out prevents a queued send. In-app messages never depend on email-provider uptime.
- Existing Resend adapter is used for real email: it must return a **provider message ID and acceptance status**. `accepted` is **NOT delivered**. Worker claims use lease tokens, exponential retries, stable email idempotency keys and bounded attempts; permanent failures become dead letters. Only a Tenant Owner can audit-requeue a dead-letter delivery, after verifying active recipient/opt-in.
- Approval Workflow independent decisions can create an in-app update for the requester **only when that tenant has Notifications and the requester is assigned**. The event uses the approval's existing DB transaction. This never executes an approved action or bypasses mandatory financial review.
- Operations Reports and Advanced Analytics can include **aggregate-only** notification counts as a separately authorized source, without exposing recipients or message bodies. Both remain separately subscribable and neither is required to use Notifications.

## Status and failure semantics

| State | Meaning |
|---|---|
| `not_requested` | In-app message committed; no email requested or recipient did not opt in |
| `pending` / `processing` | Delivery attempt queued / leased by worker; nothing has been accepted |
| `retry` | Provider/network failure; bounded retry scheduled |
| `accepted` | Email provider returned an accepted message ID **only**; not proof of inbox delivery or reading |
| `dead` | Delivery attempts exhausted or permanent rejection; retained for audited recovery |
| `suppressed` | Recipient inactive, opted out, or no longer subscribed; worker must not send |

SMS and WhatsApp are **not** enabled without a validated provider implementation. Never present an in-app notification as an SMS delivery or an accepted email as delivered.

## Local development and verification

1. Back up/commit your exact v1.20 repository, then apply the provided v1.20 → v1.21 patch after `git apply --check` succeeds. Do not copy a release ZIP over local uncommitted work.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run perf:assets`.
3. Start the isolated MongoDB replica set: `npm run db:dev:up` (Docker Desktop); run `npm run indexes`, `npm run notification:integration`, `npm run release:gate`.
4. Grant Notifications through platform module administration; assign it to staff accounts, publish a template, and test inbox, read receipt, branch restrictions, opt-in and duplicate send using two real tenant accounts. The `notification:integration` script uses random disposable **loopback-only** tenants and a stub email provider. It cannot verify a live Resend account.
5. To verify external email delivery, separately configure `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL` (HTTPS in production) and a **dedicated** `MONGO_NOTIFICATION_WORKER_URI`. Run `npm run worker:notifications` and monitor `npm run notification:doctor`. Run an authorized delivery test to your own mailbox, confirm provider acceptance ID, then check the recipient mailbox separately.

## Production deployment and monitoring

`deploy/compose.prod.yml` starts `classicfin`, `classicfin-worker` and `classicfin-notifications` from the **same immutable image digest**. Supply a private `CLASSICFIN_NOTIFICATION_ENV_FILE` using `deploy/notification-worker.env.example`; the notification worker has no public port, and does not need application session or MFA secrets. Its MongoDB user requires the minimum rights to read platform tenant metadata/heartbeats and read/update notification/recipient/preference collections in the tenant databases. Give it **no financial posting privileges**. Restrict provider API credentials to the notification worker.

`deploy/release.sh` validates both worker heartbeats and web readiness; failure triggers image rollback. `npm run notification:doctor` is a read-only monitoring check for missing workers, stalled mail, and dead letters. Configure alerts and a scheduled health-check outside this repository and verify with a controlled failure drill.

### Business and security release gates

- Online `npm audit --audit-level=moderate`, project tests, authentic local MongoDB integration, and authorization/tenant cross-access checks must pass.
- Staging must prove email acceptance, stale-lease recovery, opt-out suppression, dead-letter requeue and worker restart resilience using real credentials and controlled test accounts.
- Production must have isolated worker database permissions, verified backups and restore exercises, delivery-failure alert routing, retention policies, security review, WAF/edge protections and staging-to-production rollback evidence.
- The module does **not** claim to send SMS, execute financial operations, verify email delivery, or certify production readiness merely because source tests pass.

## Additional limitations deliberately enforced

- No arbitrary recipient email address can be passed to a send endpoint; only an active staff account with its registered email is eligible.
- No HTML execution, user-supplied external links, raw financial status, or arbitrary event-payload templating is supported. All dashboard variables are escaped through EJS.
- Workers do not repeat a subscription mutation or an approval decision on retry; only the notification delivery may be retried with a stable idempotency key.
- No live MongoDB tests or external-provider tests can be marked as passed until those services are actually reachable and a verified test executes successfully.
