---
name: verify-goals
description: Model-check Tally's shared-goal rules (goal status, membership moves, manager succession, contributions, account deletion) with TLA+ and replay them on the real store. Use when a change touches src/lib/machines/goal.ts, the goal functions in src/lib/store.ts, deleteAccountOwner, setUserEnabled, or the goals, invitations and contributions API routes.
---

# Verify shared goals

**Rule checked, in one sentence:** a live goal always has an enabled accepted manager, is completed exactly when contributions meet the target, takes no new contribution unless it is active, an archived goal has no accepted member, and members move only along the legal membership table.
**Harm if broken:** a goal nobody can manage, a goal stuck "completed" or "active" against its numbers, or a person who can join or contribute to a goal that should be closed.

## Coverage (sync commit: `1e42762`)

| Code | Model action in `model/Goals.tla` |
|---|---|
| `nextGoalStatus`, `nextMembershipStatus`, `answerInvitation`, `contributionRefusal`, `decideSuccession` in `src/lib/machines/goal.ts` | `NextStatus`, `Move`, `Respond`, `AddContribution`, `Successors` |
| `createGoal` (store.ts) | `Init` |
| `inviteToGoal` | `Invite` |
| `respondInvitation` | `Respond` |
| `changeMembership`, `succession` (store.ts) | `Leave`, `Remove`, `Change`, `Close` |
| `addContribution`, `updateContribution`, `deleteContribution` | `AddContribution`, `UpdateContribution`, `DeleteContribution` |
| `updateGoal` (target change) | `RaiseOrLowerTarget` |
| `deleteAccountOwner` (goal parts) | `DeleteAccount` |
| `setUserEnabled` (disabling runs succession) | `ToggleEnabled` |
| Routes under `src/app/api/goals`, `invitations`, `contributions` | call the store; not modeled separately |

Move the sync commit forward only after you confirm the model still describes these functions at the new commit. `git diff 1e42762 -- src/lib/machines/goal.ts src/lib/store.ts src/app/api/goals src/app/api/invitations src/app/api/contributions` shows what changed; if anything in the table moved, update the model first.

## Run it

1. Model check with the pstack `/statechart` skill, on `model/Goals.tla`:
   - `model/goals.cfg`: the nine rules that must hold (six invariants, three properties). Expect: all hold, 160,668 distinct states, under 20 seconds.
   - `model/goals-flow.cfg` with `model/goals-flow.view.mjs`: the small chart of the main user flow. Expect 108 states and 38 arrows.
   Read every result through `/statechart`; it shows each break as its shortest path.
2. Replay on the real code: `npx vitest run tests/goals.test.ts tests/goal-machine.test.ts`. The store-level tests in `tests/goals.test.ts` replay the rules on an in-memory SQLite store; `tests/goal-machine.test.ts` tests the pure functions.
3. Negative checks (run on a scratch copy of `Goals.tla`, not the repo): see Keep it able to fail.

Any break is real. First suspect the code change; only if the model's table above is out of date is it a modeling error.

## Bounds and what a pass means

3 people (person 1 creates the goal), 2 contribution slots of amount 1 or 2, target 1 to 3, one goal. A pass covers every order of the modeled actions within those bounds. Not covered: money precision (`safeMinorNumber`), names, dates and deadlines, several goals at once, the choice of successor among several (the model allows any; the code picks the earliest accepted), admin handoff, HTTP and same-origin checks, real concurrency (SQLite runs these writes in transactions or single statements).

## Findings (all fixed in `1e42762`)

1. **Stale invitation reopened a closed goal.** The manager invited someone, then left; the goal archived. The invitee's accept of the old invitation then made an accepted member on an archived goal. Fixed: `answerInvitation` refuses accept on an archived goal (test: "a pending invitation cannot be accepted after the goal is archived"). Decline still records "left" and adds no member. Replay test: `tests/goals.test.ts`.
2. **Disabling a manager left them manager.** `setUserEnabled` ran no succession, so a disabled manager kept a live goal. Fixed: disabling runs `succession` for every live goal the user manages, as leaving does (test: "a disabled manager does not stay manager of a live goal").

Found while fixing 2, the same invariant also broke with no manager change: a disabled accepted member stayed accepted when the goal archived. Fixed: archiving closes every accepted membership to "left" (test: "disabling the only enabled member archives the goal and closes the disabled members too").

## Keep it able to fail

Negative checks at `1e42762`, each on a scratch copy of `Goals.tla`:
- Drop the succession in `ToggleEnabled` (make its IF condition `FALSE`): TLC reports `ManagerIsEnabled` violated.
- Drop the accept guard in `Respond` (replace it with `TRUE`): TLC reports `ArchivedGoalHasNoAcceptedMember` violated.

Earlier: removing the `succession(...)` call in `changeMembership` fails the replay test "manager leaving hands the goal", and dropping the status recompute in the model's `AddContribution` makes `CompletedIffTargetMet` break at once. Repeat one of these after changing the model.
