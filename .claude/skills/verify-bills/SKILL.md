---
name: verify-bills
description: Model-check Tally's recurring bill schedule (create, edit, archive, midnight posting, catch-up, failures, scheduler re-arm) with TLA+ and replay the same rules on the real store. Use when a change touches createBill, updateBill, archiveBill, processDueBills, advanceBillDate, src/lib/bill-scheduler.ts, src/instrumentation.ts, src/app/api/bills, or the bill actions in bills-view.tsx or assistant.ts.
---

# Verify the bill schedule

## What is promised

- **Each due date is posted once.** A bill never charges the same date twice, and never skips a date that has passed. Harm: wrong balances and spending totals.
- **An archived bill, a bill that is not due yet, or a bill past its end date never posts.**
- **A failed posting changes nothing.** The bill stays due and is retried at the next midnight run or the next save of that bill; no date is lost.
- **The midnight timer is always re-armed** after a run, a failed bill, or a crash of the run.
- **Only a user edit moves `nextDueDate` backwards.**

## Run it

```sh
# Real code replays the model (under a minute; VERIFY_BILLS_DEPTH=4 takes about 80 seconds).
npx vitest run --config .claude/skills/verify-bills/model/vitest.config.ts
# Scheduler and API tests.
npx vitest run tests/bill-scheduler.test.ts tests/bills-api.test.ts
```

If `node_modules` is missing, run `npm ci` first. Also check the design model with the `/statechart` skill: give it `model/Bills.tla` with `model/Main.cfg` (all rules must hold), then `model/Edit.cfg` (expected to break `NoDoublePost`), and read its report: a broken rule is shown as its shortest path in plain words; a pass is a chart. For the main-flow chart use `model/BillsFlow.tla`, `model/Flow.cfg` and the view `model/flowview.ts`; `model/view.ts` is the view for `Bills.tla`.

Expected today: `Main.cfg` holds every rule. `Edit.cfg` (the API may edit `nextDueDate`) breaks `NoDoublePost`: this is a known finding, below. The second test in `conformance.test.ts` pins that finding on the real store; if it starts failing, the double post was fixed. Then update `Edit.cfg`, that test, and `docs/state-machines/bills.md`.

## Known finding (not fixed; product code is out of scope)

`PATCH /api/bills/[id]` lets the user set `nextDueDate` to today or later, even to a date that was already posted. The route then runs `processDueBills`, which posts that date again.
1. A weekly bill due 10-09 is posted for 10-09; its next due date becomes 10-16.
2. On 10-09 you edit the bill and set the next due date to 10-09.
3. The save runs `processDueBills`: a second expense dated 10-09 is posted.

## Model to code map

| Model (`model/Bills.tla`) | Code |
|---|---|
| `Init`, `end`, `first` | `createBill`, `validateBillInput` (store.ts:687-714) |
| `Edit`, stale `expected` rejected | `updateBill` (store.ts:715-743); archives when `nextDueDate > endDate` (738) |
| `Archive` | `archiveBill` (store.ts:744) |
| `BeginRun`, `cand` | the SELECT at store.ts:752 |
| `StepGone`, `StepEnded`, `StepFail`, `StepPost` | one `db.transaction` at store.ts:757-778; failure catch at 779-781 |
| `Start`, `Tick`, `Crash`, `armed` | `startBillScheduler`, `nextBillRunAt` (bill-scheduler.ts); `register` in instrumentation.ts (production only) |
| `ApiRun` | PATCH route, after `updateBill` |

Atomic step in the model = one transaction in the code. Left out: real calendar arithmetic (`advanceBillDate`: weekly +7 days, month-end anchors; covered by `tests/dates.test.ts`), several bills and users, money amounts and balances, the assistant's bill dialog (`handleAssistantBillAction`, belongs to the assistant subsystem), bill icons. In the model, edits and archives can interleave between loop steps; in the code a whole run is synchronous, so the model is stricter than needed. One bill and 4 calendar days (`MaxDay = 3`, 3,024 states for `Main.cfg`); a pass covers that bound only. The replay covers every action sequence of length 3 (or 4) on a weekly bill with three start/end shapes; it injects failures by pointing the bill at an income category.

Two guards in `processDueBills` are redundant on purpose (archived check in the SELECT and the row read versus the `archived_at IS NULL` condition of the UPDATE; the end-date check versus the `ended` calculation). Removing one alone is not caught, because the other still holds. Remove both and the replay fails.

## When a check fails

- Real code fails but the model passes: the code left the model. Fix the code, or if the change is intended, change `Bills.tla` first, then the replay.
- Model fails: read the path with `/statechart`. If the path is possible in the code (compare with the map above), it is a finding: report it, do not weaken the rule. If the code forbids it (for example the API rejects the edit), the model is too loose: tighten the action.

## Coverage record

- Files: `src/lib/store.ts` (bill functions, lines 669-788), `src/lib/bill-scheduler.ts`, `src/instrumentation.ts`, `src/lib/dates.ts` (`advanceBillDate`), `src/app/api/bills/**`.
- **Sync commit: `c006c65`.** After a change to those files, run `git diff c006c65 -- <files>`. Move the sync commit forward only after the model and the replay are confirmed to describe the new code.
- Proven able to fail at c006c65: a model without the `~archived` guard on `StepPost` breaks `NoPostWhenInactive`; a store without the three `archived_at IS NULL` conditions breaks the replay after `[tick, archive, tick]`.
