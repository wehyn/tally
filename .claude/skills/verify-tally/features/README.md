# Tally verification map

This directory is the maintained source for verifying Tally's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe. The harness is described in `../SKILL.md`.

## Baseline preconditions

- `bin/launch.sh` printed `READY`, and `bin/doctor.sh <run-dir>` reports every line `ok`.
- The instance is this run's own: `next dev` on a free 127.0.0.1 port, `TALLY_DATA_DIR=<run-dir>/data`, and the stub provider at `STUB_URL`.
- Seed: user `verifier` / `verify-password-123` (admin, assistant not opted in), default cash account `Wallet` at PHP 1,000.00, and starter categories. Nothing else exists.
- Never drive an instance this run did not start.

## Driving conventions

- Start each recipe signed in through `t.login()` from the seeded state, unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names (`getByRole`, `getByLabel`) over CSS classes or DOM position.
- Put `t.nonce` in every name or description you create, so repeated runs on one instance stay distinguishable.
- Amounts are PHP. The UI formats them as `₱1,000.00`. The API and DB use integer minor units (`balanceMinor`, `amount_minor`).
- Dates are Asia/Manila. The driver's browser already uses that timezone.

## Proof and skip reporting

- Screenshot the state before and after the action. The trace and console log are written automatically.
- A mutation's proof needs a second view: the API (`t.api`) or the DB (`t.db`), not only the screen.
- For assistant features, include the matching `provider-requests.jsonl` line. State that the tool choice was scripted through the stub.
- Name the feature ID and entry point with each artifact.
- If an entry point is unreachable, report the attempted action and the unmet precondition. Don't report it as verified through a different path.

## Feature entry contract

Each feature file has an H1, one paragraph, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright (bin/driver.mjs)`, `Gotchas`.

## Features

- [Sign in and registration](./auth.md): register, sign in, sign out, admin reset credential.
- [Accounts and transfers](./accounts.md): create, edit, set default, delete, and transfer between accounts.
- [Transactions](./transactions.md): add, edit, and delete income/expense; search the ledger; manage categories. **Journey: `journeys/transactions-add.mjs` (proven).**
- [Debts](./debts.md): add, edit, settle/reopen, and delete debts, with status filters and linked repayment history.
- [Ask Tally assistant](./assistant.md): opt in, then log transactions, debts, repayments, and bills, and ask finance questions through the widget. **Journey: `journeys/assistant-log-transaction.mjs` (proven).**

Not yet mapped: Home dashboard (`/dashboard` totals, calendar, assets), Bills (`/bills`), Shared goals (`/goals`, invitations), Settings beyond assistant opt-in (Shortcut credential, account deletion), Administration (`/admin`), and the Apple Shortcuts endpoint.
