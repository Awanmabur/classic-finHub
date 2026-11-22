# ClassicFin Hub — Public business image storage release gate

Status: **CODE PREPARED, NOT PRODUCTION-VERIFIED**. Based on live application revision `503ffcb69a9b740e33884614ab352108c7bb0bc6`. No change to financial ledger, rates, settlement, tenant DB ownership or running services is implied by this change.

## What is implemented

- Public business directory/profile links use the existing theme without unwanted underlining, with visible keyboard focus.
- Tenant Owner upload in the existing Business website editor: logo, banner and gallery. Images are encoded to WebP where the browser supports it, with a maximum delivered upload size of 3 MB and 16 MP.
- Server checks session permissions, original tenant DB identity, role, CSRF, per-user and per-tenant quotas, MIME and file signatures, dimensions and selected metadata. Server writes with bounded AWS Signature V4 requests to Cloudflare R2 `auto` region. Uploaded bytes and links are returned only after the tenant media metadata and audit event have committed.
- The existing website draft/publish flow continues to control what is displayed publicly. References to R2 images are verified against their owning tenant at draft-save and publication time. Library previews, link copy and deletion are supported. Deletion is blocked while the draft, published page or platform directory uses the asset.
- Uploaded assets are immutable URLs suitable for Cloudflare custom-domain edge caching.
- Non-media modules and financial transactions are unchanged.

## Required Cloudflare setup (not done by repository code)

1. Create a **separate public media R2 bucket**. Do not put customer KYC, financial records, backups or private support uploads in it.
2. Connect a real HTTPS custom domain to **that** bucket (for example `media.classicfinhub.com`). Public buckets are readable to anyone with a URL.
3. Create an **R2 Object Read & Write token limited to this bucket**. Store these five values exclusively in `/etc/classicfin/web.env` (0600), not in Git, HTML or browser code:
   `R2_MEDIA_ACCOUNT_ID`, `R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY`, `R2_MEDIA_BUCKET`, `R2_MEDIA_PUBLIC_URL`.
4. R2 permissions need PutObject and DeleteObject for media, and a publicly accessible GET on the configured custom domain. Keep offsite backup credentials and bucket entirely separate.
5. Update only the web service's environment; worker/notification credentials must not receive R2 media write access. Keep old secret snapshots private.

## No-deception readiness gate

- `npm test` and all existing integration/browser/security tests must pass with the current image.
- `docker exec classicfin-web-only node scripts/media-doctor.js --write-test` must pass **write, external HTTPS read, SHA-256 content comparison and deletion** on an inert 1×1 test PNG. The diagnostic emits no credentials.
- Authenticated tenant-owner functional test: PNG/JPEG/WebP upload, gallery append, save revision, publish, public profile/CDN image, directory thumbnail, replace, and unused delete; the public image must continue working on mobile.
- Negative cases: staff forbidden; unrelated tenant cannot attach/delete another tenant's image; invalid CSRF; wrong MIME; oversized/animated/corrupt image; no R2 credentials; bucket access denied; CDN unavailable; Mongo transaction fails; repeated upload; stale form; concurrent publish/delete.
- Security: audit evidence, no private file storage, least-privilege scoped token, no public directory listing of sensitive data, CDN cache semantics and image GPS metadata checks.
- Performance: mobile 320/390 and desktop 1440 widths; Core Web Vitals, page size, media transfer, browser console, external storage latency, HTTP cache responses, and load test against a disposable test tenant.
- Verify the existing production recoverability requirements separately: restored Atlas backup, correct MongoDB roles, workers, alerts, S3 backup integrity, dependency audit, payment/provider claims, and end-to-end money posting.

**Do not mark the full platform production-ready solely because the new R2 code compiles or its image service tests pass.** The current repository still describes manual entitlements rather than real paid invoicing, an unimplemented customer portal, guarded external provider settlement and other features requiring separate validation.

## Release/rollback

Base all deployment comparisons on the actual three running OCI revision labels. Deploy through the existing `deploy/standalone-ui-release.sh` with the tested SHA and a private copy of the original web environment. Verify canary and three health checks before live acceptance. Never modify balances, existing journals, rate records or historical media during the image release. Public CDN files are not re-used after deletion; cached bytes may remain available until edge caches expire.

Cloudflare reference: https://developers.cloudflare.com/r2/objects/upload-objects/ and https://developers.cloudflare.com/r2/buckets/public-buckets/
