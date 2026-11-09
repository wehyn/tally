---
name: verify-debts
description: Model-check Tally's debt register (open/settled status, payments, advances, manual edits, reopen, delete) with TLA+ and replay the model against the real store. Use when a change touches debtAfterPayment, recordDebtPayment, recordDebtRepayment, recordDebtAdvance, recordDebtAdvanceTransaction, updateDebt, deleteDebt, debtBalanceFromPayments, src/app/api/debts, or the Settle/Reopen buttons in debts-view.tsx.
---

# Verify the debt register

**Promise checked.** A debt's open or settled status, its amount, its payment history and the cash it moved never disagree, and no step leaves half a write.
**Harm if broken.** The user sees a balance that is not what they are owed, or cash that moved by the wrong amount.

## Covered code (last confirmed at commit `c006c65`)

| Model action (`model/Debts.tla`) | Code |
|---|---|
| Init (create, create with advance) | `createDebt`, `recordDebtAdvance` in `src/lib/store.ts` |
| AddAdvance | `recordDebtAdvanceTransaction` |
| Pay | `recordDebtPayment` (owed to you), `recordDebtRepayment` (you owe), `debtAfterPayment` in `src/lib/lifecycle.ts` |
| EditAmount, Settle, Reopen, EditDirection | `updateDebt` → `updateDebtInternal`; routes `src/app/api/debts/[id]/route.ts`; buttons in `src/components/debts-view.tsx` |
| Delete | `deleteDebt`, foreign keys on `transactions.debt_id` and `debt_payments.debt_id` in `src/lib/store.ts` (migrate) |

Sync commit: `c006c65`. Run `git diff c006c65 -- src/lib/store.ts src/lib/lifecycle.ts src/lib/counterparty.ts "src/app/api/debts" src/components/debts-view.tsx`. If the diff touches a function above, re-read it against the model. Move the sync commit forward here only after you confirm the model and the conformance test still describe the code at the new commit.

## Run

1. The model. Read every result with `/statechart`: give it `model/Debts.tla` with `--config model/Debts.cfg`.
   - Expected on today's code: exactly two rules break, `OpenAmountMatchesHistory` and `HistoryNeverNegative` (finding 1 below). `AmountPositive`, `CashMatchesLinkedTransactions`, `DirectionStableOnceLinked`, `NoActivityOnSettled`, `NoLinkAfterDelete` and `NoDeadlock` hold. About 6,500 states, a few seconds.
   - `model/Debts_ReopenFix.cfg` turns on a hypothetical fix. Everything must hold. It shows the rules are satisfiable.
   - `model/Debts_Mutant_PayOnSettled.cfg` and `model/Debts_Mutant_DirectionUnlocked.cfg` remove a guard on purpose. `NoActivityOnSettled` must break in the first, `DirectionStableOnceLinked` and `CashMatchesLinkedTransactions` in the second. If they hold, the rules went blind.
   - To draw the main flow, use `Debts_FlowOwed.cfg` (or `Debts_FlowOwe.cfg`) with `--view model/Debts_Flow.view.ts`. The same flow is in `docs/state-machines/debts.md`.
2. The real code. From a checkout with `node_modules` (run `npm ci` first if missing):
   `npx vitest run --config .claude/skills/verify-debts/conformance/vitest.config.ts`
   Eight tests replay each model action on an in-memory store. All must pass on today's code.

## Telling a real bug from a modeling error

- A conformance test fails and `git diff c006c65` touches the function it names: the code changed. Decide whether the new behavior is intended. If it is not, it is a bug. If it is, change the model action and the test together.
- The model run shows a new broken rule: replay its steps through the store (the test file shows how). If the store behaves differently, fix the model. If it behaves the same, report a finding. Never weaken a rule to make it pass.
- The known-finding test (`model: Reopen and settled edits`) fails because the code was fixed: good. Flip the expected results in `Debts.cfg` (use the `SettledHistoryFrozen` settings that match the fix), delete finding 1 below, and move the sync commit.

## Finding 1 (current code, not fixed)

*Reopen disagrees with payment history.* A payment-settled debt keeps its last positive amount, and reopening it (`updateDebt` with status `open`) writes no history row.
Steps: lend ₱10 → the borrower pays ₱10 (debt settled, amount ₱10, history 0) → Reopen. The screen shows ₱10 outstanding while `debtBalanceFromPayments` says 0; one more ₱10 payment drives it to −₱10. A second route: after settling, edit the amount down. The adjustment is measured against the retained amount, so the history goes negative. `tests/debts.test.ts` ("sums payment deltas exactly…") already pins a negative balance, so the owners know history can go negative. `debtBalanceFromPayments` has no caller in `src/` yet, so no user sees the mismatch today. It matters when a caller (a debt detail view, say) starts to display it.

## Scope

Verified: one debt, amounts 1–3, direction, status, history sum, cash effect, linked-transaction count, in every order of the actions above, with the history sum limited to ±6 and at most 3 transactions.
Not verified: SQLite atomicity (each store function is one `db.transaction`, assumed all-or-nothing; the tests in `tests/debts.test.ts` cover rollback), counterparty rows (`ensureCounterparty`, cleanup), the assistant's choice of which debt to pay (`src/lib/assistant.ts`), per-owner isolation, money range limits, transaction kind classification (income/spending totals), several debts at once.
