# Tenant workspace configuration

The approved tenant workspace navigation is served under `/tenant/workspace`.
Configuration is stored in `TenantWorkspaceConfigV1` and the typed
`TenantWorkspaceEntryV1` collection inside the tenant's dedicated MongoDB
logical database. Settings do not use browser storage.

The owner can update business identity, contact information, IANA timezone,
default display currency, landing headline and service list, branding colors,
receipt template identity, and receipt footer. Domain routing, account login
email, immutable financial references, transaction currencies, fixed server
roles, and platform subscription entitlements retain their existing controlled
workflows. The profile form shows domain fields as read-only.

Native dialogs follow the approved two-column form layout with Close, Cancel,
and Save changes. Every action also has a server-rendered form URL that works
without JavaScript. Forms include CSRF tokens and expected revisions. Editing a
stale settings form returns a conflict instead of overwriting a newer update.
All successful writes and exports record an audit event. A failed audit write
rolls back the business change.

Settings operations re-read the active account's fixed role and current tenant
subscription from MongoDB, validate the derived tenant database name, and reject
forged caller roles. Writes also lock the tenant and account authorization rows
within the same MongoDB transaction to serialize against revocation and
concurrent settings updates.

## Pages and working actions

- **Tenant profile:** saved business identity and contact preferences.
- **Landing page setup:** headline and services, ordered sections, draft,
  published or hidden status, edit, archive, restore, preview, and publish.
  Publishing captures an immutable public-content snapshot. Later draft edits
  remain private until the owner publishes again. Public content is served at
  `/t/:slug` with escaped text and no authenticated customer data.
- **Branding & receipts:** brand and receipt settings use separate approved
  dialogs. Validated colors load through the private external tenant theme
  stylesheet. Current acknowledgements show the configured business name,
  support contact, template identity, and footer while preserving original
  record references and financial status.
- **Roles & permissions:** current fixed server capabilities and a link to
  supported staff assignments. Tenant configuration cannot grant arbitrary
  permissions.
- **Customer/KYC setup, compliance controls, integrations, notification rules:**
  typed, validated policy and connection descriptions with revision checks,
  archive, restore, and audit. Integration credentials are rejected from
  descriptions. Working SMS device enrollment and notifications have links to
  their separately entitled operational modules.
- **Tenant database:** actual tenant database storage/document statistics and
  an audited health check. Backup configuration presence is distinguished from
  a verified backup. Full-replica encrypted backups and restores remain
  operator workflows and cannot be launched or downloaded by a tenant session.
- **Subscription & limits:** authoritative platform-issued plan snapshot,
  module grants, capacity, and period; module requests remain the route for
  subscription changes.
- **Import / export data:** scoped settings JSON and audit CSV downloads, plus
  the separately authorized customer CSV export. Import job descriptions are
  stored as drafts; unavailable execution is recorded as rejected rather than
  reporting simulated completion.
- **Landing, receipt, and customer portal previews:** current saved content,
  with private draft previews and explicit customer-service availability.
- **Tenant audit activity and control center:** recorded changes and links to
  actual staff, audit, cash-control, and operational screens.

KYC fields, compliance rules, integration descriptions, and notification-rule
records document policy. They do not install executable financial rules,
provider connections, a scheduler, or a customer login service. Public receipt
verification and QR verification remain disabled. Mandatory operation reviews,
module permissions, and subscription limits remain enforced by their existing
server services.

## Verification

Run unit checks with:

```sh
node tests/workspace-settings.test.js
```

Run the disposable real-MongoDB and authenticated HTTP checks with a local
replica set and the usual application environment:

```sh
NODE_ENV=test node scripts/workspace-settings-integration.js
```

The integration script refuses production or non-loopback targets, creates
random scratch platform and tenant databases, and drops only those databases.
It verifies fresh authorization, tenant isolation, stale and concurrent writes,
audit rollback, lifecycle restoration, published snapshot isolation, escaped
public content, statistics and exports, CSRF protection, authenticated form
persistence, theme CSS, and account/tenant revocation.
