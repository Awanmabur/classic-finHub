# Verified dead-code cleanup — 7 November 2026

The launch cleanup removes 153 disconnected files (8,348,631 bytes): 125 legacy JavaScript files, 17 unmounted duplicate views and 11 unused image assets. The [exact manifest](dead-code-manifest.json) records every removed path, original size and SHA-256, and the base Git revision preserves recovery history. No database, tenant record, private storage directory or volume is removed.

## Verification method

The JavaScript review traced relative literal CommonJS dependencies from `src/server.js`, `src/app.js`, every CLI/integration script and test. Package worker entrypoints and all background jobs were explicitly retained as roots. Dynamic imports in the fail-closed regression tests were reviewed and retained. The actual consolidated platform/tenant routers, dynamic operation-workspace view maps, EJS includes and template tests were inspected before deleting old alternatives. Files being edited by other launch tasks were excluded, and file hashes were checked again immediately before deletion.

Removed scaffold included empty routers, redirect-only controllers, unused permissive Mixed schema variants, broad unused validators, duplicate layouts/views and fake in-memory CRUD services superseded by persisted staff/invitation/account workflows. The smoke inventory now checks mounted module views and the actual TransferOrder schema rather than requiring disconnected marketplace views and the old MoneyTransfer schema to exist.

Image references were checked across application source, stylesheets, scripts, tests, active/original templates and the approved root `index.html`. The optimized `bg.webp`, `prt.webp` and `fx.webp`, active logos, bundled font assets and their licenses remain. Their obsolete JPEG originals and unreferenced prototype PNGs were removed. Anonymous stock-photo testimonial images were removed after the public-page task replaced unsupported testimonials with factual workflow content. Historical performance notes may mention the deleted JPEG names as the inputs to their earlier optimization.

## Deliberately retained

- The approved root `index.html`, its generated stylesheet and original public/reference templates.
- Real financial services, ledger/treasury models, migrations, expiry jobs, workers, notification/outbox tasks, backup/recovery tooling and deployment entrypoints.
- Test-referenced fail-closed financial and unimplemented-service boundaries. Their deliberate errors must not be mistaken for fake successful features.
- Active customers/accounts/expenses/workspace routes and the guarded public marketplace.

This is a reviewed reachability cleanup, not a proof that every remaining export or asset is used on every licensed installation. Runtime-built module paths, optional operational commands and historical design assets require review rather than deletion based on a filename or a zero literal-import count. Historical review documents describe earlier revisions; use the launch runbook and mounted routes for current behavior.

## Validation

Cleanup verification passed 381/381 application tests, including the updated smoke inventory and dynamic fail-closed regressions; syntax/template checking passed for 469 remaining JS/EJS files. Optimized marketing-image budgets passed. A follow-up scan found no missing literal relative imports in runtime source or operational scripts. These counts describe the cleanup check while other launch work was in progress; use the final launch report for the completed revision. The root release verification separately exercises live mounted routes, financial integration, browser navigation, public assets and deployment configuration.
