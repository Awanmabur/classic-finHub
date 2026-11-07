# Launch workspace layout

The approved `index.html` remains the visual reference. Its ordered CSS blocks, navy palette, control borders, modal dimensions and sticky behavior remain intact. Launch spacing adapters follow those blocks.

## Navigation

The temporary Phase 2 group is removed. Its implemented features now belong to their working areas:

| Area | Items |
| --- | --- |
| Overview | Owner dashboard / advanced analytics |
| Operation Reports | Approvals and corrections, manual movement review, cash control review |
| Tenant Workspace | Wallets and balances, notifications, staff, audit, roles, system settings |

The duplicate staff, audit and security-role destinations were consolidated. Navigation and report sources still require the active subscription, staff module assignment and relevant fixed permission. The direct legacy `/tenant/workspace/control` route redirects to tenant profile.

## Profile guidance

Tenant profile contains the operational guide for configuring financial accounts, confirming opening balances, choosing defaults, adding funds and reviewing actual balances. Its action links follow financial source entitlements and Treasury permissions. Setup fields remain on Wallets; daily transaction forms use configured defaults.

## Spacing contract

- Adjacent top-level page containers use a 14px gap. Old direct inline top margins are replaced by that shared gap to prevent doubled spacing.
- Approved card heads and bodies retain their 14px wall padding; form sections retain their approved 16px padding and 14px internal gaps.
- Workspace card/form grids use 14px gaps; action groups use 10px gaps.
- Workspace notes have no extra paragraph margin. Their wall padding is 14px. Facts and guide text wrap within the container.
- Workspace introduction padding is 18px on desktop and 16px on narrow screens. The profile guide changes from two columns to one at 720px.
- Grid children have `min-width: 0`; long action labels can wrap rather than widening the page. Tables retain their own horizontal scrolling.

Browser checks should include dashboard, tenant profile, Wallets, reports and operation dialogs at 1440, 900, 390 and 320px, with focus, scroll and report-filter behavior verified separately.
