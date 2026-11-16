# Forex Buy/Sell rate separation: guarded release

This release adds side-specific approved rates while preserving the existing Classic FinHub styling, unrelated modules, immutable quoted rates, cash books, review permissions and history.

- Buy: business receives foreign currency and pays settlement currency.
- Sell: business delivers foreign currency and receives settlement currency.
- Indicative quote: no money movement. Existing rates without an explicit side are preserved as indicative and must not be inferred to be trading rates.
- One active rate per branch, directional pair and side. A reviewer cannot approve their own proposal. A newly approved rate supersedes only the earlier rate for its own side. Same-pair Buy must be below Sell when both are active.
- Executable Forex quote creation checks the rate side inside the MongoDB transaction. A Buy rate cannot be used for a Sell quote, even by submitting a handcrafted request. Unexpired historical quotes retain their original immutable quote snapshot.
- Quotes do not post a cash transaction; funded manual review remains the existing posting path. EUR is still indicative-only.

## Mandatory index migration for existing tenant databases

The old MongoDB unique index, `one_active_forex_rate_per_pair`, must be retired; otherwise a second active rate for USD/UGX is rejected. The new unique index is `one_active_forex_rate_per_pair_side`.

1. Back up the tenant database and independently verify a restorable copy.
2. Stop Forex rate and quote writes in a documented maintenance window.
3. On the reviewed source revision, run the read-only inventory: `node scripts/forex-rate-side-migrate.js --tenant=TENANT_SLUG`.
4. With backup and outage confirmed, run: `node scripts/forex-rate-side-migrate.js --tenant=TENANT_SLUG --apply --maintenance-confirmed --backup-verified`.
5. The migration labels only historical records with missing side as `quote`, creates/verifies the new index, and **only then** removes the legacy index. Run for every existing Forex tenant; new tenants only need the new index.
6. Run focused tests `node --test tests/forex.test.js tests/operation-choices.test.js` and disposable real-Mongo integration `npm run forex:integration`. Do not run disposable DB integration against production.
7. Deploy the exact reviewed release image with normal canary/rollback checks. Verify both Buy and Sell board entries are independently approved and visible only in their respective forms, and that an opposite-side request is rejected.

Never manually relabel existing indicative rates as Buy/Sell without a real pricing proposal and independent approval. Never drop unique indexes without first verifying a backup and the replacement index. 
