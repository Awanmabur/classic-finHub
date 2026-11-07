# Wallet, branch and approved behavior verification — 7 November 2026

Fresh Chromium sessions used isolated temporary Mongo databases and generated identities. No production records or provider APIs were used. [Sanitized results](verification.json) record the tested outcomes.

The live UI was compared with `index.html` at 1440, 390 and 320px. The desktop sidebar stayed at y18 during 650px document scroll; navigation scrolled independently. Modal service tabs, headers and footers stayed fixed while their body scrolled. Focused phone/native select controls had no inner border or outline and retained one approved outer border/ring. Banking's hidden currency value created no extra empty pill. Mobile drawer focus, body locking, Escape, backdrop and focus restoration passed. The reference topbar scrolls normally.

Wallet setup, default accounts, fee policy, funding and observations stay on Wallets. The daily form auto-selects an eligible default wallet and has no repeated balance, payment-account or fee-policy setup controls. A 5,000 UGX funding transfer left both books unchanged while pending; independent review reduced bank by 5,000 and increased wallet by 5,000, with a balanced ledger. Policy changes between opening and posting a form are rejected instead of silently changing the preview.

Owner view defaulted to Main, switched to Jinja and All, and retained that selection across 16 reporting filter submissions. An owner-created wallet used the selected Jinja setup branch despite a forged body Main value; the operating account stayed Main. All view required choosing a branch before account creation. A daily transaction while viewing Jinja explicitly identified operating Main, posted there, and redirected to its accessible detail.

All tested browser runs reported zero JavaScript or asset errors. These are measured interaction/component and workflow checks, rather than a claim of pixel identity for every populated page.

[Sticky mobile modal](modal-sticky-390.png) · [Banking inputs](banking-inputs-1440.png) · [Clean daily transaction](daily-transaction-390.png) · [Reviewed funding](funding-posted-1440.png)

See [wallet and branch setup](../../MANUAL_FUNDS_AND_UI.md) for current operation and deployment instructions.
