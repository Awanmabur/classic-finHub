# Optional MFA and tenant onboarding — 1.27.0

Verified on 9 November 2026 (Africa/Kampala), using random disposable loopback replica-set databases. No existing account, enrollment, credential or live Atlas data was modified.

- 488 unit/HTTP tests passed. The full release gate passed, including financial/authorization integrations, the expanded tenant lifecycle, explicit MFA off/on integration, Android relay tests and npm audit (zero vulnerabilities). Static checks passed for 529 JS/EJS files.
- Real password-only platform and tenant-owner sign-in was verified with `MFA_ENABLED=false` and no authenticator encryption key. Sessions contain no fabricated MFA verification. Re-enabling MFA rejects those sessions, requires genuine enrollment/challenge, and preserves existing enrollment/ciphertext.
- The tenant HTTP lifecycle injects real native index-command permission and network errors. The response retains form values and returns a curated 403/503 with no leaked database command; storage readiness stays 200 and no tenant/invite/creation audit is published. Restoring the index command lets the same request succeed with its unique financial index verified. Revocation during storage preparation prevents publication.
- Owner activation-link recovery is transactional and audited. It expires earlier unused links, checks profile revision and active Super Admin access, and rejects an activated owner. CSRF and anonymous requests remain blocked.
- [Browser results](browser.json): fresh password-only Super Admin login, empty catalogue, plan publication, tenant creation, subscription grant, replacement activation link, owner activation and owner password login. Ten layouts at 1440/390 px had no overflow, duplicate IDs, script exceptions or failed static assets. The actual Node watcher booted once and remained ready after all steps.
- [Container results](container.json): Node 22.23.4, non-root, read-only runtime and protected routes. The final image also passed the real tenant lifecycle/fault-injection and MFA policy integrations.

The original Windows disconnect was not reproduced on the managed Linux host. These checks substantiate the handled failure/retry paths and watcher stability; they do not verify the user's live Atlas permissions or network. A denied Atlas tenant-database setup now explains the required access on the form.

Reproduce with `npm run tenant:integration`, `npm run mfa-policy:integration` and optional `npm run tenant:browser`. The browser command needs Playwright and Chromium, uses the local replica set on port 27018, masks one-time activation links in screenshots and removes its temporary fixture data. Set `CHROMIUM_PATH` and `BROWSER_REVIEW_DIR` when needed. These are development checks, absent from the production runtime dependencies.
