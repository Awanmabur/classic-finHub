# SMS-assisted entry, configurable plans and the tenant workspace

The system now supports manual entry and a separately entitled SMS-assisted mode.
Both use the same database-backed Mobile Money records, cash controls, quotas and
independent review. SMS reception does not assert payment settlement or execute a
provider transaction.

This guide covers **incoming Android Mobile Money capture** and its plan pricing.
Outbound receiver PIN SMS for Money Transfer is a separate transactional workflow:
after independently reviewed collection it uses Twilio through the tenant
notification worker. It does not consume the Android capture quota or require
the staff Notifications add-on. Configure that service through the
[deployment setup checklist](DEPLOYMENT_SETUP.md#4-configure-receiver-transfer-sms)
and follow the [transfer operating procedure](OPERATIONS_MANUAL.md#11-money-transfer-sender-entry-through-final-payout).

## Platform administrator: create and price plans

Open **Plans → Create plan**. Set a stable code, name, description, monthly and
yearly USD prices, trial duration, included modules, staff/branch capacity,
transaction quota, SMS allowance and storage allowance. Save the draft, review it,
then publish with a reason. Drafts do not affect tenant access.

Create a manual plan first. For its automatic counterpart choose **SMS-assisted +
manual entry**, select the manual counterpart, include **Mobile Money** and
**SMS Capture**, and set a positive SMS allowance. The non-SMS modules and workspace
capacities must match the manual counterpart. Both automatic prices must be
strictly higher. The system rejects equal/lower automatic prices and manual
repricing that would make a comparable available automatic plan cheaper. Raise
the automatic plan first when increasing both tiers. No particular commercial
price is imposed by the application; the administrator chooses the totals.

Publication creates an immutable version with an audit entry. Existing subscribers
keep their assigned price/module/limit snapshot until a separate subscription
change. Latest published, available versions drive tenant creation and public
pricing. Hiding a latest version does not resurrect an older public price.
Catalogue publication is serialized across plan codes so concurrent repricing
cannot bypass the premium relationship.

Custom plans are not limited to the original starter catalogue. A plan without a
trial can create an invited tenant, but it grants no operations automatically:
the administrator must grant its subscription from the tenant profile. This does
not claim a payment was collected. SMS Capture cannot be attached through the
legacy independent-module grant to bypass its premium-plan pricing.

The storage allowance remains plan metadata; this change does not add a general
uploaded-file storage metering system. Staff, branches, operational records and
SMS capture have their existing dedicated enforcement paths.

## Tenant owner: connect the Android phone

1. Assign the SMS-assisted plan and give the operator Mobile Money and SMS Capture
   access. Create the branch and assign the operator to it.
2. Open **SMS Capture** and enroll the Android device against that operator,
   network and the exact trusted sender IDs observed on the phone.
3. Copy the one-time signing secret into the phone's private relay configuration.
   The [Android relay guide](../tools/android-sms-relay/README.md) supplies the
   runnable Termux:API/Python program and installation steps. The application must
   have a reachable HTTPS address configured as `APP_URL` for the phone.
4. Receive a new message and inspect the web inbox. Enable automatic recording
   only after confirming that actual network wording matches a supported profile
   and the operator has an independently verified open cash shift.

Manual entry is always available, including when the SMS quota is exhausted.
History/detail pages identify **Manual** versus **SMS capture** records. Unknown
messages enter the review inbox, where the assigned operator can inspect and
complete their fields. Fees and cash-in/out direction are not guessed.

The current conservative parser profile requires an explicit confirmation, such
as `MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Jane Doe; Ref: ABC12345`.
**MTN SSD (South Sudan)** is a distinct network, with its own wallet and reference
namespace. Its explicit supported example is `MTN SSD Cash In: SSP 1,000.25; Fee: SSP 10.05; Customer: Jane Doe; Ref: SSD12345`.
UGX, USD, SSP and KES are supported when the explicit currency, accounts and
verified operator drawer agree. One currency's cash cannot cover another.
Real provider formats vary; this is not a declaration that every native MTN,
Airtel or M-Pesa message matches that example. Unmatched messages are still
captured. The intended phone, its SMS permission/background behavior and its real
provider samples require acceptance testing on that device.

## Automatic branch context

Transaction forms and the shared transaction dialog have no branch selector or
hidden branch override. The server resolves the active branch from the signed-in
account. A legacy owner with exactly one active branch can use that branch. A
multi-branch owner must configure an operating branch in Branch Management;
transactions do not guess a location. Staff branch assignment remains an owner or
branch-manager administration setting. Owner reports retain their authorized
workspace-wide visibility.

An enrolled phone is bound to its operator and branch. Reassigning the operator,
revoking their module access, disabling the account/device or removing the SMS
subscription stops capture/recording. These checks are fenced inside the same
transaction as the final financial record, not only when the HTTP request begins.
Older messages cannot be attached to a newer verified cash shift; they remain
reviewable instead of changing today's cash drawer.

See [automatic branch context](AUTOMATIC_BRANCH_CONTEXT.md) for implementation and
migration behavior.

## Dashboard and modals

The uploaded `index.html` remains the visual reference. The tenant workspace now
uses its transaction launcher, centered operation-sheet layout, recent activity
and cash-drawer arrangement. The launcher loads the actual permitted server forms
and submits the existing protected routes, preserving CSRF and idempotency. The
dialog shows errors and loading state, traps keyboard focus and closes with
Escape. Staff only see actions their role and subscription allow.

Cash drawer figures come from independently verified open physical-cash shifts
and are labelled provisional; they are not provider balances. Recent activity and
the latest acknowledgement link refer to real scoped records. Open cash shift
uses the existing opening workflow, and closing links to the actual reconciliation
form. Transaction forms show their resolved operating branch. Owners and auditors
can separately switch their permitted reading view between Main, another branch
and All without changing that operating assignment.

Customers, ledger-mapped accounts, reviewed expenses and manual funded transfer,
Banking and Forex movements use their implemented database-backed services.
Live provider payout execution remains separate work recorded in
[the issue register](PROJECT_REVIEW.md). Visual alignment does not certify
external provider settlement.

## Integrity, privacy and validation

Each device has an encrypted signing secret and a strict sender allowlist.
Receipts require a raw-body HMAC, a five-minute timestamp window and a strict
envelope without tenant/branch fields. Stable message IDs, financial idempotency
and unique network references prevent duplicate records. Capture and financial
quotas are separate. Interrupted recording can recover its original record
without charging another unit or moving cash twice.

SMS text is encrypted in the tenant database and expires after 30 days. Device
credentials appear once at enrollment. The Android relay retains an owner-only
retry queue, scrubs acknowledged bodies, uses verified TLS, refuses redirects and
never logs message text or secrets. Phone enrollment/revocation, confirmations and
dismissals retain their audit trails. Messages and sender IDs are personal data;
configure the dedicated relay only for the required business senders.

Run the complete local gate with `npm run release:gate`. New dedicated checks are
`npm run plan:integration`, `npm run branch:integration`, `npm run sms:integration`,
`npm run sms:authorization`, and `npm run relay:test`. The SMS integration also
calls the actual Python relay against the Node receiver. The authorization check
commits device/account/branch/subscription changes between draft validation and
recording and verifies they prevent the write without changing cash or quotas.
No live Android phone or provider settlement was exercised in the cloud instance.


## Verified release evidence

The final local release gate passed 290 JavaScript tests, 13 Python relay tests,
static checks for 493 JS/EJS files, and all existing/new database integrations.
The online npm advisory audit returned zero findings. Final browser checks at
1440, 390 and 320 pixels verified real plan draft saving, SMS enrollment/operator
scope, manual transaction recording, opening a cash shift and the centered dialog
without branch selection or clipped controls. These are local results, not a
claim of Android hardware or production provider certification.

Safe synthetic-data captures: [transaction chooser](review/transaction-sms-enabled-1440.png),
[manual entry](review/manual-cash-in-320.png), [cash shift](review/open-cash-shift-320.png),
[plan editor](review/plan-new-320.png), [SMS inbox](review/sms-owner-320.png).
