# Transactions

The ledger lists the user's income, expenses, transfers, and debt repayments grouped by Manila date. Users add, edit, search, and delete entries and manage their categories. Each entry moves the chosen account's balance.

## Sub-features

- `tx-add` adds an income or expense through the `Add transaction` dialog.
- `tx-edit` changes amount, account, description, date/time, or category.
- `tx-delete` permanently deletes after confirmation (disabled for debt-linked rows).
- `tx-search` filters the ledger with `Search this ledger`.
- `tx-categories` adds, renames, re-icons, and deletes categories in `Manage categories`.

## How to get to it (user POV)

- Main navigation `Money`, then the `Transactions` card, or `/transactions`.
- Home dashboard `All transactions` link in Recent activity.
- `Money` → `Categories` card goes to `/transactions#category-manager`.
- Entries can also be created through Ask Tally (see `assistant.md`). That is a separate entry point with its own proof.

## Driving it with Playwright (bin/driver.mjs)

Preconditions: `Wallet` exists. Starter category `Food` (expense) exists.

- **Add (proven: `journeys/transactions-add.mjs`).** On `/transactions`, click the `Add transaction` button. In `getByRole("dialog", { name: "Add transaction" })`, fill `Amount in PHP` with `250.00` and select `Financial account` `Wallet · default`. Fill `Description (optional)` with `verify coffee ${t.nonce}`, select `Category` `Food · expense`, and click `Save transaction`. The dialog closes, and `getByRole("row").filter({ hasText: description })` appears under today's date group with `−₱250.00`. Prove it with the Wallet `balanceMinor` dropping by 25000, and with one `transactions` row (`kind='expense'`, `source='manual'`, `amount_minor=25000`).
- **Edit.** Click `Edit <description>` (icon button). The dialog title is `Edit transaction`. Change the amount and click `Save changes`. Recheck the row and balance.
- **Delete.** Click `Permanently delete <description>` and confirm. The row disappears and the balance is restored.
- **Search.** Fill `getByPlaceholder("Search this ledger")` with the nonce. Only matching rows remain.

## Gotchas

- Time defaults to the current Manila time. Entries in the same date group sort by time, so don't assert row position.
- Debt-linked rows (`debtId`) lock the amount and disable delete with the title "Delete the debt first...". That's expected, not a bug.
- `Undo` buttons appear only on assistant-created rows, within their undo window.
- Taking a screenshot with Playwright's default `caret: "hide"` before hydration causes a React hydration warning on the search input. The driver uses `caret: "initial"`. Keep it that way, or `console.log` gets false alarms.
