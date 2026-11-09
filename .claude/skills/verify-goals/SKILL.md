---
name: verify-goals
description: Model-check Tally's shared-goal rules (goal status, membership moves, manager succession, contributions, account deletion) with TLA+ and replay them on the real store. Use when a change touches src/lib/lifecycle.ts goal or membership code, the goal functions in src/lib/store.ts, deleteAccountOwner, setUserEnabled, or the goals, invitations and contributions API routes.
---

# Verify shared goals

**Rule checked, in one sentence:** a live goal always has an accepted manager, is completed exactly when contributions meet the target, takes no new contribution unless it is active, and members move only along the legal membership table.
**Harm if broken:** a goal nobody can manage, a goal stuck "completed" or "active" against its numbers, or a person who can join or contribute to a goal that should be closed.

## Coverage (sync commit: `c006c65`)

| Code | Model action in `model/Goals.tla` |
|---|---|
| `nextGoalStatus`, `nextMembershipStatus`, `MEMBERSHIP_MOVES` in `src/lib/lifecycle.ts` | `NextStatus`, `Move` |
| `createGoal` (store.ts) | `Init` |
| `inviteToGoal` | `Invite` |
| `respondInvitation` | `Respond` |
| `changeMembership`, `succession` | `Leave`, `Remove`, `Change` |
| `addContribution`, `updateContribution`, `deleteContribution` | `AddContribution`, `UpdateContribution`, `DeleteContribution` |
| `updateGoal` (target change) | `RaiseOrLowerTarget` |
| `deleteAccountOwner` (goal parts) | `DeleteAccount` |
| `setUserEnabled` (no goal logic) | `ToggleEnabled` |
| Routes under `src/app/api/goals`, `invitations`, `contributions` | call the store; not modeled separately |

Move the sync commit forward only after you confirm the model still describes these functions at the new commit. `git diff c006c65 -- src/lib/lifecycle.ts src/lib/store.ts src/app/api/goals src/app/api/invitations src/app/api/contributions` shows what changed; if anything in the table moved, update the model first.

## Run it

1. Model check with the pstack `/statechart` skill, on `model/Goals.tla`:
   - `model/goals.cfg`: the rules that must hold. Expect: all hold (about 292,000 states, under a minute).
   - `model/goals-findings.cfg`: two rules that **currently break** (Findings below). Expect exactly `ManagerIsEnabled` and `ArchivedGoalHasNoAcceptedMember` to break, nothing else.
   - `model/goals-flow.cfg` with `model/goals-flow.view.mjs`: the small chart of the main user flow.
   Read every result through `/statechart`; it shows each break as its shortest path.
2. Replay on the real code: copy `replay/goals-replay.test.ts` to `tests/`, run `npx vitest run tests/goals-replay.test.ts`, then delete the copy. Expect 3 passed and 2 expected-fail (the two findings, marked `it.fails`).

Any other break is real. First suspect the code change; only if the model's table above is out of date is it a modeling error.

## Bounds and what a pass means

3 people (person 1 creates the goal), 2 contribution slots of amount 1 or 2, target 1 to 3, one goal. A pass covers every order of the modeled actions within those bounds. Not covered: money precision (`safeMinorNumber`), names, dates and deadlines, several goals at once, the choice of successor among several (the model allows any; the code picks the earliest accepted), admin handoff, HTTP and same-origin checks, real concurrency (SQLite runs these writes in transactions or single statements).

## Findings (current code, confirmed by replay)

1. **Stale invitation reopens a closed goal.** The manager invites someone. The manager leaves; nobody has accepted, so the goal is archived. The invitee answers the old invitation with accept (`respondInvitation` checks only that the row is `invited`, not the goal's status). The archived goal now has an accepted member and no manager. Low impact: archived goals cannot take contributions and are hidden.
2. **Disabling a manager leaves them manager.** An admin disables the manager (`setUserEnabled` runs no succession). The goal stays active with a manager who cannot sign in, so nobody can invite, remove or change the target until the manager is re-enabled. No other member can take over.
Neither was changed in product code. If a fix lands, move the rule from `goals-findings.cfg` to `goals.cfg`, flip the `it.fails` test, and update `docs/state-machines/goals.md`.

## Keep it able to fail

Prove-it done at `c006c65`: removing the `succession(...)` call in `changeMembership` fails the replay test "manager leaving hands the goal"; dropping the status recompute in the model's `AddContribution` makes `CompletedIffTargetMet` break at once. Repeat one of these after changing the model.
