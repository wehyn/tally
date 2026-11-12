# Manual debt tracking

## Sub-features

Create debts owed to you or debts you owe. Filter open and settled records and view linked history.

## How to get to it (user POV)

Open `/debts`. Click **Add debt** at the top, the empty-state button, or **Add** in a direction panel.

## Driving it with Playwright

The `drive` command uses the first **Add debt** button, fills **Person or organization** and **Current amount · PHP**, and submits **Add debt** within the dialog. It creates two Mom debts, ₱1000 then ₱200, and an Ari debt of ₱500, all owed to the owner. Manual entry must create no transactions. After settlement, click **Settled** and check Mom's retained balance label. Alternate create buttons, outgoing debts, edits, manual settlement, reopening, and deletion are not covered.

## Gotchas

Duplicate counterparties are distinct debts. The assistant pays the oldest matching open debt rather than merging their amounts. Manual debts do not change cash.
