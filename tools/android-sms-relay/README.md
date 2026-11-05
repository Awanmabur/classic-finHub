# Android SMS relay

This is a working Python relay for a dedicated Android phone using Termux:API.
It reads only configured sender IDs, queues new messages on the phone, and sends
signed HTTPS requests to the enrolled ClassicFin device endpoint. Manual entry
in the web application remains available. It is not an APK or a cloud service
that can read a phone without installation and Android SMS permission.

## Connect the phone

1. Publish and assign an SMS-assisted plan with Mobile Money and a positive SMS
   allowance. Assign the operator's branch and modules. In **SMS Capture**, enroll
   the phone against that operator and network; copy the one-time device secret.
2. Install Termux and the matching Termux:API Android add-on from the same trusted
   distribution. Grant the API add-on Android SMS permission. In Termux run:
   `pkg install python termux-api`. Confirm `termux-sms-list -t inbox -l 1` works
   privately on the phone; do not paste its output into tickets or chat.
3. Copy `relay.py` onto the phone. Run `python relay.py --init`. Enter the HTTPS
   endpoint and the device secret at the hidden prompt. Set the same explicit
   sender IDs as the enrolled device. Do not use a personal phone's entire inbox.
4. Run `python relay.py --once` to initialize the new-message baseline. Messages
   already in the inbox are skipped. Receive a new supported network message,
   then run once again and check the web SMS inbox. For a deliberate historical
   import, use `--import-existing` on the **first** run with a separate new queue;
   the server only accepts messages from the last 30 days.
5. Run `python relay.py` continuously. Use `termux-wake-lock` and the phone's
   battery/background settings so Android permits the dedicated relay to remain
   active. Termux:Boot can start it after a reboot. Delivery stops while the phone
   is off, lacks SMS permission, or Android stops Termux; the relay scans paginated
   inbox history and retries its persistent queue after recovery.

The private configuration defaults to `~/.classicfin-sms/config.json`, mode 600.
Never share it. Each device/workspace needs a separate queue file; the relay
refuses to send an existing queue to a changed endpoint. Revoking the enrolled
device in the web UI stops its access. Rotate by enrolling a new device and
configuring a new queue, preserving any unacknowledged records for review.

## What automation means

Every accepted message appears in the encrypted, tenant/branch-scoped web inbox.
With automatic recording enabled, complete supported confirmations are recorded
as **pending verification**, using the existing operator, cash-shift, quota and
independent-review controls. SMS reception does not establish provider settlement.
Missing or unrecognized fields stay in the inbox for review and completion.

Until a real network's message format is supplied and verified, the built-in
strict confirmation profile is:

`MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Jane Doe; Ref: ABC12345`

The profile also supports explicit Cash Out, Airtel/M-Pesa and supported KES
amounts. This example is not a claim that every native MTN/Airtel/M-Pesa SMS has
that format. Unknown native messages are retained for review, not guessed into
financial records. Enrollment binds the device to the operator's active branch;
the relay never submits a tenant or branch selector.

## Delivery and privacy

- The signature is HMAC-SHA256 with the hex-decoded 32-byte device secret over
  `unix_seconds + '.' + exact_UTF8_JSON`. Headers are `X-SMS-Timestamp` and
  `X-SMS-Signature`. Payload fields are exactly `messageId`, `sender`,
  `receivedAt` (UTC ISO timestamp) and `body`.
- Successful 200/202 acknowledgments remove SMS text from the local queue but
  keep its fingerprint to prevent re-forwarding. The server independently
  deduplicates messages and network references.
- Network failures, 5xx and 429 are retried with backoff. 401/403 preserve the
  queue and pause for an hour: check device status, clock, subscription and
  credentials. Permanent 400/409/413/422 errors are dead-lettered. Use
  `python relay.py --status` to see counts without printing SMS contents.
- Pending SMS stays in a private local SQLite queue until acknowledged. Dead
  payloads are scrubbed after seven days; fingerprints remain. The pending queue
  stops collection at 10,000 messages rather than silently discarding old data.
  Keep the Android inbox until backlog recovery is verified. Messages older than
  the server's 30-day acceptance window need operator review instead of retries.
- TLS certificate verification remains enabled. HTTP is accepted only for
  explicit loopback development configuration. Redirects are not followed.
  Logs contain counts and status codes, not messages, phone numbers or secrets.

## Validation

Run `python3 -m unittest discover -s tools/android-sms-relay -p 'test_*.py'` from
the checkout. Tests exercise allowlists, baseline import, durable deduplication,
retry behavior, acknowledgement scrubbing, endpoint binding, file permissions and
a real local HTTP request with the exact raw-body signature. Android hardware,
runtime permissions, background survival and a real network's SMS format still
need verification on the intended phone. No live phone was connected during the
cloud tests.
