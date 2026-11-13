---
name: verify-debts
description: Model-check Tally's debt register (open/settled status, payments, advances, manual edits, reopen, delete) with TLA+ and replay the model against the real store. Use when a change touches debtAfterPayment, recordDebtPayment, recordDebtRepayment, recordDebtAdvance, recordDebtAdvanceTransaction, updateDebt, deleteDebt, debtBalanceFromPayments, src/app/api/debts, or the Settle/Reopen buttons in debts-view.tsx.
---

# Verify the debt register

**Promise checked.** A debt's open or settled status, its amount, its payment history and the cash it moved never disagree, and no step leaves half a write.
**Harm if broken.** The user sees a balance that is not what they are owed, or cash that moved by the wrong amount.

## Covered code (last confirmed at commit `6793ed8`)

| Model action (`model/Debts.tla`) | Code |
|---|---|
| Init (create, create with advance) | `createDebt`, `recordDebtAdvance` in `src/lib/store.ts` |
| AddAdvance | `recordDebtAdvanceTransaction` |
| Pay | `recordDebtPayment` (owed to you), `recordDebtRepayment` (you owe), `debtAfterPayment` and `acceptsPayment` in `src/lib/machines/debt.ts` |
| EditAmount, Settle, Reopen, EditDirection | `updateDebt` → `updateDebtInternal`, with `historyAdjustmentForUpdate`, `nextDebtStatus` and `canChangeDirection` in `src/lib/machines/debt.ts`; routes `src/app/api/debts/[id]/route.ts`; buttons in `src/components/debts-view.tsx` |
| Delete | `deleteDebt`, foreign keys on `transactions.debt_id` and `debt_payments.debt_id` in `src/lib/store.ts` (migrate) |

Sync commit: `6793ed8`. Run `git diff 6793ed8 -- src/lib/store.ts src/lib/machines/debt.ts src/lib/counterparty.ts "src/app/api/debts" src/components/debts-view.tsx`. If the diff touches a function above, re-read it against the model. Move the sync commit forward here only after you confirm the model and the conformance test still describe the code at the new commit.

## Run

1. The model. Read every result with `/statechart`: give it `model/Debts.tla` with `--config model/Debts.cfg`.
   - Expected on today's code: every rule holds (`AmountPositive`, `OpenAmountMatchesHistory`, `HistoryNeverNegative`, `CashMatchesLinkedTransactions`, `DirectionStableOnceLinked`, `NoActivityOnSettled`, `NoLinkAfterDelete`, `NoDeadlock`). About 6,500 states, a few seconds.
   - `model/Debts_Mutant_ReopenWritesNothing.cfg` is the pre-fix behavior (`SettledHistoryFrozen = FALSE`). `OpenAmountMatchesHistory` must break. If it holds, the reopen rule went blind.
   - `model/Debts_Mutant_PayOnSettled.cfg` and `model/Debts_Mutant_DirectionUnlocked.cfg` remove a guard on purpose. `NoActivityOnSettled` must break in the first, `DirectionStableOnceLinked` and `CashMatchesLinkedTransactions` in the second. If they hold, the rules went blind.
   - To draw the main flow, use `Debts_FlowOwed.cfg` (or `Debts_FlowOwe.cfg`) with `--view model/Debts_Flow.view.ts`. The same flow is in `docs/state-machines/debts.md`.
2. The real code. From a checkout with `node_modules` (run `npm ci` first if missing):
   `npx vitest run --config .claude/skills/verify-debts/conformance/vitest.config.ts`
   Nine tests replay each model action on an in-memory store. All must pass on today's code.

## Telling a real bug from a modeling error

- A conformance test fails and `git diff 6793ed8` touches the function it names: the code changed. Decide whether the new behavior is intended. If it is not, it is a bug. If it is, change the model action and the test together.
- The model run shows a new broken rule: replay its steps through the store (the test file shows how). If the store behaves differently, fix the model. If it behaves the same, report a finding. Never weaken a rule to make it pass.

## Scope

Fixed in `33ce376`: reopening a payment-settled debt (finding 1 in `docs/state-machines/debts.md`). Fixed in `e62878e`: reopening a legacy negative history at a very large amount, which `tests/debts.test.ts` pins and this model does not reach, because its amounts stop at 3. Verified: one debt, amounts 1–3, direction, status, history sum, cash effect, linked-transaction count, in every order of the actions above, with the history sum limited to ±6 and at most 3 transactions.
Not verified: SQLite atomicity (each store function is one `db.transaction`, assumed all-or-nothing; the tests in `tests/debts.test.ts` cover rollback), counterparty rows (`ensureCounterparty`, cleanup), the assistant's choice of which debt to pay (`src/lib/assistant.ts`), per-owner isolation, money range limits, transaction kind classification (income/spending totals), several debts at once.
