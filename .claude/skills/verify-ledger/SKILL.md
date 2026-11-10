---
name: verify-ledger
description: Model-check Tally's ledger rules (financial accounts, the default account, transactions, transfers, assistant Undo, debt-linked rows) with TLA+ and replay the same rules on the real store. Use when a change touches createAccount, setDefaultAccount, updateAccount, deleteAccount, assertTransactionInput, createTransaction, updateTransaction, deleteTransaction, listAccounts, assertLedgerTotalsSafe, the category functions in src/lib/store.ts, src/lib/transaction-model.ts, or the accounts, transactions and categories API routes.
---

# Verify the ledger

## What is promised, and what breaks if it fails

| Property (TLA+ name) | Plain sentence | Harm if broken |
| --- | --- | --- |
| `OneDefault` | A user with any account has exactly one default account, and `users.default_account_id` names it. | The assistant and Shortcut log money into no account or a wrong one. |
| `KeepOneAccount` | Once a user has an account they always have one. | "Log a transaction" has nowhere to post. |
| `TxnRefsValid`, `NoOrphan` | Every transaction uses the user's own accounts and an income/expense category of the matching type; a transfer has two different accounts and no category. | Another person's account is credited, or income is counted as spending. |
| `TransfersNeutral` | The combined balance is opening money plus income and debt repayments minus spending; transfers do not change it. | The dashboard total drifts from the ledger. |
| `UndoShape` | Only assistant rows can be Undone and a debt-linked row never can. | Undo deletes a row that a debt still points at. |

Balances are derived (`listAccounts` adds the rows up), so delete, edit and Undo restore balances exactly by construction. The replay checks the derived balance against an independent model after every step.

## Files and what each does

- `model/Ledger.tla`: the model. `model/Ledger.cfg`: full check (2 own accounts, 1 foreign account, 2 transaction slots, amount 1, bases 0 and 1; about 128,000 states, about 100 s). `model/Ledger.chart.cfg` + `model/ledger.view.mjs`: a 59-state bound that draws the key-flow chart.
- `replay/ledger-replay.test.ts` (+ `replay/vitest.config.ts`): 300 seeded random walks of 25 actions on a real in-memory store. A reference model written from the TLA+ guards predicts accept or reject for each action and every balance; the real database is checked against every invariant after each step. About 7 s.

## Coverage record

Sync commit: `c006c65`. The verification was confirmed to describe this code at that commit.

| Model action | Code (`src/lib/store.ts`) |
| --- | --- |
| `CreateAccount` | `createAccount`: first account becomes default, mirrors to `users.default_account_id` |
| `SetDefault` | `setDefaultAccount` |
| `SetBalance` | `updateAccount`, `balanceMinor` branch |
| `DeleteAccount` | `deleteAccount`: bill guard, keep one, no history, default moves to a remaining account |
| `CreateTxn` | `createTransaction` + `assertTransactionInput` + `assertMovementFields` + `insertTransaction` |
| `CreateRepayment` | `recordDebtPayment` |
| `EditTxn` | `updateTransaction` |
| `DeleteTxn`, `ExpireUndo` | `deleteTransaction`, `undo_until` |
| `Bal`, `Flow` | `listAccounts` |
| schema | `financial_accounts`, `transactions`, `categories` tables and the `accounts_one_default` index (the schema in `migrate`) |

Also covered: `src/lib/transaction-model.ts` (`isManualTransactionKind`), the accounts, transactions and categories routes only as callers of these functions.

When a covered function changed after the sync commit (`git diff c006c65 -- src/lib/store.ts src/lib/transaction-model.ts`), re-read the changed function against the table, update the model and replay, rerun both checks, and only then move the sync commit forward to the commit you confirmed.

## Run it

1. Model check: use the pstack `/statechart` skill on `model/Ledger.tla` with `model/Ledger.cfg`. Every rule must hold. Read any violation with `/statechart`; it prints the shortest path.
2. Replay on the real code, from the repo root (needs `node_modules`; run `npm ci` first if absent):
   `npx vitest run --config .claude/skills/verify-ledger/replay/vitest.config.ts`
3. Chart for review: `/statechart` on `model/Ledger.tla` with `model/Ledger.chart.cfg` and `--view model/ledger.view.mjs`.

## Reading a failure

- Replay message `seed N: <actions> expect accept|reject` means the real store and the model disagree about one action. Reproduce with that seed. If the real code is right and the product rule changed on purpose, change `Valid`/guards in `Ledger.tla` and the guard expression in the replay together. If the code is wrong, that is a finding: report it with the printed actions; do not edit the model to hide it.
- Replay message `OneDefault|TxnRefsValid|TransfersNeutral|UndoShape ... <actions>` is an invariant broken in the real database.
- TLC violation with no replay failure usually means the model changed. Check the model edit first.

## Scope (honest)

Verified: the rules above for one user, up to 2 owned accounts, 2 transaction rows, amount 1, kinds income, expense, transfer, debt_repayment, source manual or assistant, plus one account owned by someone else. The replay explores more depth (25 steps, 3 account slots) but samples, it does not cover everything.

Not covered: amounts and the overflow guard `assertLedgerTotalsSafe`; dates, times, descriptions; categories beyond "type is fixed and must match" (there is no category delete or type change in the code, so type cannot drift); bills (modeled only as an on/off flag that blocks account deletion); debt records and the debt side of `recordDebtPayment`; two requests racing (each store call is one SQLite immediate transaction, assumed atomic); account deletion of the whole user. The model picks any remaining account as the new default, the code picks the oldest; both satisfy `OneDefault`.

## Proof that the checks can fail (run at sync commit)

- Removing the default hand-over in `deleteAccount`: TLC reports `OneDefault` broken in 3 steps (add two accounts, delete the default); the replay fails with `OneDefault`.
- Dropping the category-type check in `assertTransactionInput`: the replay fails with a wrong-type category accepted.
