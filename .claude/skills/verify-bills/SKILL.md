---
name: verify-bills
description: Model-check Tally's recurring bill schedule (create, edit, archive, midnight posting, catch-up, failures, scheduler re-arm) with TLA+ and replay the same rules on the real store. Use when a change touches createBill, updateBill, archiveBill, processDueBills, advanceBillDate, src/lib/machines/bill.ts, src/lib/bill-scheduler.ts, src/instrumentation.ts, src/app/api/bills, or the bill actions in bills-view.tsx or assistant.ts.
---

# Verify the bill schedule

## What is promised

- **Each due date is posted once.** A bill never charges the same date twice, including after the user edits its next due date. Harm: wrong balances and spending totals.
- **An archived bill, a bill that is not due yet, or a bill past its end date never posts.**
- **A failed posting changes nothing.** The bill stays due and is retried at the next midnight run or the next save of that bill; no date is lost.
- **The midnight timer is always re-armed** after a run, a failed bill, or a crash of the run.
- **Only a user edit moves `nextDueDate` backwards, and never onto a date already posted.**

## Run it

```sh
# Real code replays the model (about 12 seconds at depth 3; VERIFY_BILLS_DEPTH=4 runs longer, not timed).
npx vitest run --config .claude/skills/verify-bills/model/vitest.config.ts
# Scheduler, API and machine tests.
npx vitest run tests/bill-scheduler.test.ts tests/bills-api.test.ts tests/bill-machine.test.ts
```

If `node_modules` is missing, run `npm ci` first. Also check the design model with the `/statechart` skill, one config at a time:

- `model/Main.cfg`: every rule must hold.
- `model/Edit.cfg`: the API may edit `nextDueDate`, and the guard is on. Every rule must hold.
- `model/Unguarded.cfg`: the same edits with the guard off. It must break `NoDoublePost`. This is the proof that the check can fail.

For the main-flow chart use `model/BillsFlow.tla`, `model/Flow.cfg` and the view `model/flowview.ts`; `model/view.ts` is the view for `Bills.tla`.

## Fixed finding

`PATCH /api/bills/[id]` used to accept a `nextDueDate` equal to a date already posted, and `processDueBills` then posted that date again. `updateBill` now refuses any next due date on or before the bill's `last_posted_due_date` (`canScheduleDueDate` in `src/lib/machines/bill.ts`). The refusal is a 400 with "was already posted". Moving the date forward, or to an unposted date after the last post, still works.

The model's `GuardEdit` constant is the guard. `Unguarded.cfg` keeps the old behavior as a counterexample. The replay has two date actions (`date` at offsets 0 and +1 from today); it checks that the real store accepts or refuses each one exactly as the rule says. The store test "refuses to move a posted bill back to a date already posted" pins the same path.

Known gap: a bill posted before `last_posted_due_date` existed has no record until its next post. An edit to a date posted before the deploy is not refused yet.

## Model to code map

| Model (`model/Bills.tla`) | Code |
|---|---|
| `Init`, `end`, `first` | `createBill`, `validateBillInput` (store.ts) |
| `Edit`, stale `expected` rejected | `updateBill` (store.ts); `GuardEdit` is `canScheduleDueDate`; archives when `nextDueDate > endDate` |
| `Archive` | `archiveBill` (store.ts) |
| `BeginRun`, `cand` | the SELECT of due bills in `processDueBills` (store.ts) |
| `StepGone`, `StepEnded`, `StepFail`, `StepPost` | `planPosting` (`src/lib/machines/bill.ts`) decides `none`, `end` or `post`; the store persists it in one `db.transaction`; a throw inside it is the failure case |
| `Start`, `Tick`, `Crash`, `armed` | `startBillScheduler`, `nextBillRunAt` (bill-scheduler.ts); `register` in instrumentation.ts (production only) |
| `ApiRun` | PATCH route, after `updateBill` |

Atomic step in the model = one transaction in the code. Left out: real calendar arithmetic (`advanceBillDate`: weekly +7 days, month-end anchors; covered by `tests/dates.test.ts`), several bills and users, money amounts and balances, the assistant's bill dialog (`handleAssistantBillAction`, belongs to the assistant subsystem), bill icons. In the model, edits and archives can interleave between loop steps; in the code a whole run is synchronous, so the model is stricter than needed. One bill and 4 calendar days (`MaxDay = 3`, 3,024 states for `Main.cfg`); a pass covers that bound only. The replay covers every action sequence of length 3 (or 4) on a weekly bill with three start/end shapes, including date edits; it injects failures by pointing the bill at an income category.

The model's `ExactlyOnce` and `NoLostDue` are checked only with `AllowDateEdit = FALSE`, because a forward date edit skips dates on purpose. The replay checks `NoDoublePost` always and `ExactlyOnce` until the first accepted date edit.

## When a check fails

- Real code fails but the model passes: the code left the model. Fix the code, or if the change is intended, change `Bills.tla` first, then the replay.
- Model fails: read the path with `/statechart`. If the path is possible in the code (compare with the map above), it is a finding: report it, do not weaken the rule. If the code forbids it (for example the API rejects the edit), the model is too loose: tighten the action.

## Coverage record

- Files: `src/lib/machines/bill.ts`, `src/lib/store.ts` (bill functions), `src/lib/bill-scheduler.ts`, `src/instrumentation.ts`, `src/lib/dates.ts` (`advanceBillDate`), `src/app/api/bills/**`.
- **Sync commit: `39578af`.** After a change to those files, run `git diff 39578af -- <files>`. Move the sync commit forward only after the model and the replay are confirmed to describe the new code.
- Proven able to fail: a model without the `~archived` guard on `StepPost` breaks `NoPostWhenInactive` (checked at c006c65); a store without the three `archived_at IS NULL` conditions breaks the replay after `[tick, archive, tick]` (checked at c006c65, not re-run since the machine extraction); a model with `GuardEdit = FALSE` breaks `NoDoublePost` (`Unguarded.cfg`, checked at 39578af); a store with the `canScheduleDueDate` check disabled breaks the replay and the store test (checked at 39578af).
