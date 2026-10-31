# Debts

Users track money owed to them and money they owe, grouped by person. Debts don't change account balances by themselves. Repayments recorded through Ask Tally create a linked `Debt repayment` transaction and reduce the debt together. A settled debt keeps its last positive amount, labelled as the last outstanding balance.

## Sub-features

- `debt-add` adds a debt with direction, person, amount, an optional due date, and a note.
- `debt-edit` changes an existing debt.
- `debt-settle` toggles a debt between settled and open.
- `debt-delete` removes a debt (and frees its linked transactions for deletion).
- `debt-filter` switches between `Outstanding`, `Settled`, and `All debts`.
- `debt-history` shows linked activity per debt (advances and repayments).

## How to get to it (user POV)

- Main navigation `Plan`, then the `Debts` card, or `/debts`.
- The page heading button `Add debt`, or the per-section `Add` buttons in `Owed to you` and `You owe`, which preselect the direction.
- Ask Tally: "Mina owes me 500", "Mina paid me 200" (see `assistant.md`).

## Driving it with Playwright (bin/driver.mjs)

Preconditions: there are no debts in the seed. Create one first.

- **Add.** On `/debts`, click the `Add debt` button (the heading one: `getByRole("button", { name: "Add debt" }).first()`). In `getByRole("dialog", { name: "Add a debt" })`, select `Direction` `Owed to you`, fill `Person or organization` with `Mina ${t.nonce}`, fill `Current amount · PHP` with `500`, and click `Add debt`. In `getByRole("region", { name: "Owed to you debt list" })`, the group `Debts with Mina …` shows `₱500.00` and `Outstanding`. The `Outstanding debt totals` card updates. Prove it with a `debts` row: `status='open'`, `amount_minor=50000`. The Wallet balance is unchanged.
- **Settle.** Click `Settle owed to you debt 1 with Mina …`. The status text becomes `Settled · last outstanding balance` and the amount stays `₱500.00`. Under the `Outstanding` filter it disappears. It shows under `Settled`.
- **Reopen.** Under `Settled`, click `Reopen owed to you debt 1 with Mina …`.
- **Delete.** Click `Delete owed to you debt 1 with Mina …` and confirm.
- **Repayment history.** Record a repayment through the assistant (`assistant.md` → `ast-debt-payment`). Then `Linked activity for debt with Mina …` lists a `Debt repayment · Wallet` item, and the debt amount drops.

## Gotchas

- Action button names include the index within the person group (`debt 1`, `debt 2`, …) and the trimmed counterparty.
- Manual debts never move account balances. Asserting a balance change here is wrong. Repayments through the assistant do move them.
- Settled debts show a positive amount by design. Status is authoritative.
- Duplicate debts for the same person are not merged. Repayments apply to the oldest open one.
