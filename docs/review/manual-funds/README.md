# Manual funds and UI browser evidence — 6 November 2026

Fresh Chromium sessions used isolated disposable Mongo databases and generated identities. No production records or live provider APIs were used.

- Real rendered banking deposit/withdrawal/customer transfer, forex buy/sell, transfer collection/PIN/payout and MoMo cash-in/out persisted the expected book and balanced journals after independent review.
- Missing manual wallet actual balance returned HTTP 400. A reported UGX 1 discrepancy retained the book, held the wallet, and blocked the next posting with HTTP 409. The detail page distinguishes book balances from dated reported actual and review status.
- Filters survived real submission on 16 reporting/activity pages. No JavaScript or asset errors occurred.
- Forty-two operation modal captures across 1440px, 390px and 320px had zero differences in compared CSS properties/design tokens. All captured mobile sheet/head/body/footer rectangles matched the reference. Desktop overview rectangles matched. Full populated pages are not asserted to be pixel-identical: the requested branch picker removal, actual funds controls and assigned-currency cash sheets change content.
- Conditional Cash/Wallet Balance controls and all six operation/fee-treatment previews passed. An explicitly collected fee changes customer pays/receives; an informational commission does not.

[Overview](overview-1440.png) · [Mobile cash-in](cash-in-390.png) · [Wallet discrepancy evidence](wallet-discrepancy.png)

See [the current funds guide](../../MANUAL_FUNDS_AND_UI.md) for setup and financial boundaries. Full release validation is recorded there for the committed revision; these screenshots capture browser verification, not live provider settlement.
