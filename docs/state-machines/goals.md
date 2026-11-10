# Goals state machines

Verified by `.claude/skills/verify-goals` (TLA+ model, sync commit `1e42762`).

## Inventory

| Machine | States | Legal moves (guard) |
|---|---|---|
| Goal status | `active`, `completed`, `archived` | `nextGoalStatus` (`src/lib/machines/goal.ts:9`): archived is terminal; otherwise completed iff raised ≥ target. Recomputed on contribution add/edit/delete (`store.ts:1170, 1191, 1202`) and target change (`store.ts:1134`). Archived is set only by `succession` (`store.ts:1137`). |
| Membership | none, `invited`, `accepted`, `left`, `removed`, `former` | `MEMBERSHIP_MOVES` (`machines/goal.ts:19`): invite from none/left/removed; accept/decline from invited; leave/remove from accepted. `former` only by account deletion (`store.ts:1205`). Accept is refused on an archived goal (`answerInvitation`, `machines/goal.ts:33`). |
| Manager | a user, or none | Set at `createGoal`; changed only by `succession` (choice by `decideSuccession`, which takes a cause). A leaving, removed or deleted manager (`changeMembership`, `deleteAccountOwner`) hands the goal to the earliest enabled accepted member, or archives it when there is none. A disabled manager does the same hand-over, but with no such member nothing changes: the goal, its manager and its memberships wait for the re-enable. `handOverFromDisabledManager` runs after `setUserEnabled` in either direction and after an invitation is accepted, so the goal moves as soon as an enabled accepted member exists. Archiving closes every accepted membership. |
| Contribution | exists / deleted; owner or "Former member" | Add needs an accepted member and an `active` goal (`contributionRefusal`, `machines/goal.ts:41`, used at `store.ts:1161`); edit and delete need the owner to be an accepted member (`store.ts:1175`, `:1194`). |

## Main flow: invite, contribute, complete, hand over

Two people; person 1 manages. Chart from `goals-flow.cfg` (108 model states, 38 arrows; edits, disabling and account deletion left out; steps that stay in one state are not drawn).

```mermaid
---
title: "Shared goal: invite, contribute, complete, hand over"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: tan
    lg1: teal
    lg2: blue
  }
  class lg0 tan
  class lg1 teal
  class lg2 blue
  s0: Active, invitee not invited
  s1: Active, invitee invited
  s2: Completed, invitee not invited
  s3: Archived, no manager
  s4: Active, invitee member
  s5: Completed, invitee invited
  s6: Active, invitee left
  s7: Completed, invitee member
  s8: Completed, invitee left
  s9: Active, invitee removed
  s10: Active, invitee took over
  s11: Completed, invitee removed
  s12: Completed, invitee took over
  [*] --> s0
  s0 --> s1: the manager invites the other person
  s0 --> s2: someone contributes enough to meet the target or the manager lowers the target
  s0 --> s3: you leave and nobody can take over
  s1 --> s4: invitee accepts
  s1 --> s5: someone contributes enough to meet the target or the manager lowers the target
  s1 --> s6: invitee declines
  s1 --> s3: you leave and nobody can take over
  s2 --> s0: the manager raises the target
  s2 --> s5: the manager invites the other person
  s2 --> s3: you leave and nobody can take over
  s4 --> s6: invitee leaves
  s4 --> s7: someone contributes enough to meet the target or the manager lowers the target
  s4 --> s10: you leave and the invitee takes over
  s5 --> s1: the manager raises the target
  s5 --> s7: invitee accepts
  s5 --> s8: invitee declines
  s5 --> s3: you leave and nobody can take over
  s6 --> s1: the manager invites the other person
  s6 --> s8: someone contributes enough to meet the target or the manager lowers the target
  s6 --> s3: you leave and nobody can take over
  s7 --> s4: the manager raises the target
  s7 --> s8: invitee leaves
  s7 --> s12: you leave and the invitee takes over
  s8 --> s5: the manager invites the other person
  s8 --> s6: the manager raises the target
  s8 --> s3: you leave and nobody can take over
  s9 --> s1: the manager invites the other person
  s9 --> s11: someone contributes enough to meet the target or the manager lowers the target
  s9 --> s3: you leave and nobody can take over
  s10 --> s3: invitee leaves
  s10 --> s12: someone contributes enough to meet the target or the manager lowers the target
  s11 --> s5: the manager invites the other person
  s11 --> s9: the manager raises the target
  s11 --> s3: you leave and nobody can take over
  s12 --> s10: the manager raises the target
  s12 --> s3: invitee leaves
  s10 --> s6: invitee leaves
  s12 --> s8: invitee leaves
  class s0 blue
  class s1 blue
  class s2 teal
  class s3 tan
  class s4 blue
  class s5 teal
  class s6 blue
  class s7 teal
  class s8 teal
  class s9 blue
  class s10 blue
  class s11 teal
  class s12 teal
```

The view hides edits, disabling and account deletion. Regenerate with `/statechart` on `goals-flow.cfg` and `goals-flow.view.mjs`. Leaving as the last accepted member archives the goal; leaving with another accepted, enabled member hands management to them. Disabling the last enabled accepted member archives nothing.

## Rules that hold (all 10 pass, 206,757 states)

Manager matches status; a live goal's manager is enabled unless no other enabled accepted member exists; completed iff target met; former members own nothing; membership moves only along the table; contributions only while active; an archived goal has no accepted member; archived is terminal; enabling or disabling a user never archives a goal or closes a membership.

## Findings (all fixed)

1. **Stale invitation accepted after archive** (rule: an archived goal has no accepted member). Path: manager invites → manager leaves (goal archived) → invitee accepts. Fixed: `answerInvitation` refuses accept on an archived goal. Decline still records "left". Low impact before the fix.
2. **Disabled manager stays manager** (rule: a live goal's manager is enabled, unless nobody else can take over). Path: admin disables the manager → goal active, manager cannot sign in. Fixed: `setUserEnabled` hands the goal to the earliest enabled accepted member, as leaving does. Medium impact before the fix: nobody else could manage the goal.
3. **Disabled member stays accepted after archive** (found while fixing 2; same rule as 1). Path: a disabled accepted member remains accepted when the last enabled manager leaves and the goal archives. Fixed: archiving closes every accepted membership to "left". Archived goals are hidden, so nothing a user sees changes.
4. **Disabling archived a goal nobody else could take over** (rule: enabling or disabling a user never archives a goal; found in review, a regression of the fix for 2). Path: Bob creates a goal alone and adds ₱400 → admin disables Bob → admin re-enables Bob. The goal was archived at the disable, so it and its contributions vanished from Bob's view and `addContribution` and `updateGoal` answered "Goal not found." The product decision is that disabling is reversible, so it hands the goal on when an enabled accepted member exists and otherwise leaves the goal, its manager and its memberships alone. Account deletion and a manager leaving keep their rule and archive when no one can take over. Fixed in `decideSuccession`, which takes a cause (`leave` or `disable`) and answers `keep` for a disable with no successor. Two follow-on moves keep the first rule true: enabling a member while the manager is disabled, and accepting an invitation while the manager is disabled, hand the goal to the enabled accepted member (`handOverFromDisabledManager`). Pinned by the tests "a goal only the disabled user belongs to comes back whole when they are re-enabled", "disabling the only enabled member keeps the goal, its manager and every membership, so re-enabling restores it", "enabling a member hands a goal held by a disabled manager to them", "accepting an invitation hands a goal held by a disabled manager to the new member", "deleting the account of the only enabled member still archives the goal and closes the disabled members". `goals-archive-on-disable.cfg` (the earlier rule) fails `TogglingNeverArchives`; `goals-no-handover.cfg` (no hand-over at all) fails `ManagerIsEnabledUnlessAlone`.

Replay tests: `tests/goals.test.ts`. Pure rules: `tests/goal-machine.test.ts`.
