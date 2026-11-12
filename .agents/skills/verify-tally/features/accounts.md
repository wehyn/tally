# Financial accounts

## Sub-features

Create a cash or bank account, set an opening balance, and choose a default account.

## How to get to it (user POV)

Open `/accounts`. Click **New account**, or **Add account** in the empty state.

## Driving it with Playwright

The `drive` command clicks **New account**, fills **Account name** with Wallet and **Set balance** with 0, then clicks **Create account** within the dialog. The first account is the default. After repayment, readonly `/api/accounts` must report Wallet's balance as 100000 minor units. The alternate empty-state button, bank accounts, editing, transfers, and changing the default are not covered.

## Gotchas

Opening balances are not income. Missing a default or named account requires clarification before an assistant repayment can persist. The seeded journey creates one account and does not cover that clarification branch.
