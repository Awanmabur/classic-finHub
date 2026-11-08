# Automatic transaction location

Transaction and cash-shift forms no longer ask for a branch. The server resolves
the location from the authenticated account and validates it against the tenant's
active branch records. The initial currency comes from that branch's default;
transactions may select any of its enabled operating currencies. Submitted branch overrides are rejected, including those
submitted by a tenant owner.

- Staff use their assigned active branch. Missing or archived assignments block
  operations until a tenant owner corrects the account.
- Creating the first branch assigns it to an owner account that does not already
  have an operating branch. Existing single-branch owners also resolve safely to
  their sole active location.
- An existing owner with multiple active branches and no assignment must save an
  account location in **Branches → Your operating branch**. The system never
  guesses among several locations or accepts a branch from the transaction form.
- Changing an owner's operating location is an audited account configuration
  action. It does not limit their access to workspace-wide reports or independent
  reviews.

SMS devices bind to an operator and branch during administrative configuration.
The SMS ingestion service checks that the account's current resolved branch still
matches the configured device. The message body is not an authority for selecting
a tenant or branch.

The shared policy is `transactionBranch.service.js`. Creation services enforce it
independently of HTTP middleware, so direct service callers cannot bypass branch
validation. Contact directories, bank references, rates, approval requests and
cash-shift creation use the same operation context. Read-only reporting retains
its existing owner/staff scope.

Validation includes unit tests for assigned, missing, ambiguous, archived and
forged branches; rendering tests for eight operational views; and a disposable
MongoDB integration exercising first-branch assignment, audited owner reassignment,
cash opening, exact KES recording and cross-tenant rejection. Existing module
integration checks also continue to exercise their independent review controls.
