# Accounts and transfers

Users keep cash and bank accounts with a set balance, mark one as the default (used when the assistant or a form omits an account), and move money between accounts with transfers that change balances but not income or spending.

## Sub-features

- `acct-create` adds a cash or bank account with an initial balance (not recorded as income).
- `acct-edit` renames an account or sets its current balance.
- `acct-default` makes another account the default.
- `acct-delete` removes an account after a confirmation (blocked while transactions reference it).
- `acct-transfer` creates, edits, and deletes transfers between two accounts.

## How to get to it (user POV)

- Main navigation `Money`, then the `Accounts` card, or go directly to `/accounts`.
- Home dashboard `View accounts` link in the Assets panel.
- With no accounts, the empty state shows an `Add account` button.

## Driving it with Playwright (bin/driver.mjs)

Preconditions: the seeded `Wallet` (default, PHP 1,000.00) exists. A transfer needs a second account.

- **Create account.** On `/accounts`, click the `New account` button. In `getByRole("dialog", { name: "New financial account" })`, fill `Account name` with `Bank ${t.nonce}`, select `Type` `bank`, fill `Set balance` with `500.00`, and submit. A card with heading `Bank ${t.nonce}` shows `₱500.00`. Prove it with `t.api("/api/accounts")`: `balanceMinor === 50000`.
- **Make default.** On the new card, click `Make default`. The `Default` badge moves to that card. Prove it with the `isDefault` flags from the API.
- **Transfer.** Click `Transfer` (enabled only with two or more accounts). In `getByRole("dialog", { name: "Transfer between accounts" })`, fill `Amount in PHP` with `200`, select `From account` `Wallet` and `To account` the new bank, and submit. Both balances change by 200. The Transactions ledger shows a transfer row with a `Manage` link, and the dashboard income and spending stay unchanged.
- **Delete.** Click `Delete <name>` (icon button), then confirm with `Delete account` in the confirmation dialog.

## Gotchas

- Option labels in account selects carry a suffix for the default: `Wallet · default`. Select by that exact label, or by value.
- The balance shown is `opening + adjustments + transactions`. Editing `Set balance` creates an adjustment and does not rewrite history.
- Transfers can't be edited from Transactions. That row only links back to `/accounts`.
