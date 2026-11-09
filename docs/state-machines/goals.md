# Goals state machines

Verified by `.claude/skills/verify-goals` (TLA+ model, sync commit `1e42762`).

## Inventory

| Machine | States | Legal moves (guard) |
|---|---|---|
| Goal status | `active`, `completed`, `archived` | `nextGoalStatus` (`src/lib/machines/goal.ts:9`): archived is terminal; otherwise completed iff raised ≥ target. Recomputed on contribution add/edit/delete (`store.ts:1170, 1191, 1202`) and target change (`store.ts:1134`). Archived is set only by `succession` (`store.ts:1137`). |
| Membership | none, `invited`, `accepted`, `left`, `removed`, `former` | `MEMBERSHIP_MOVES` (`machines/goal.ts:19`): invite from none/left/removed; accept/decline from invited; leave/remove from accepted. `former` only by account deletion (`store.ts:1205`). Accept is refused on an archived goal (`answerInvitation`, `machines/goal.ts:33`). |
| Manager | a user, or none | Set at `createGoal` (`store.ts:1064`); changed only by `succession` (`store.ts:1137`, choice by `decideSuccession`, `machines/goal.ts:58`) from `changeMembership` (`store.ts:1156`), `setUserEnabled` when disabling (`store.ts:342`) and `deleteAccountOwner` (`store.ts:1219`). Archiving closes every accepted membership. |
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

The view hides edits, disabling and account deletion. Regenerate with `/statechart` on `goals-flow.cfg` and `goals-flow.view.mjs`. Leaving as the last accepted member archives the goal; leaving with another accepted, enabled member hands management to them.

## Rules that hold (all 9 pass, 160,668 states)

Manager matches status and is enabled; completed iff target met; former members own nothing; membership moves only along the table; contributions only while active; an archived goal has no accepted member; archived is terminal.

## Findings (all fixed in `1e42762`)

1. **Stale invitation accepted after archive** (rule: an archived goal has no accepted member). Path: manager invites → manager leaves (goal archived) → invitee accepts. Fixed: `answerInvitation` refuses accept on an archived goal. Decline still records "left". Low impact before the fix.
2. **Disabled manager stays manager** (rule: a live goal's manager is enabled). Path: admin disables the manager → goal active, manager cannot sign in. Fixed: `setUserEnabled` runs `succession` for every goal the user manages, as leaving does. Medium impact before the fix: nobody else could manage the goal.
3. **Disabled member stays accepted after archive** (found while fixing 2; same rule as 1). Path: a disabled accepted member remains accepted when the last enabled manager leaves and the goal archives. Fixed: archiving closes every accepted membership to "left". Archived goals are hidden, so nothing a user sees changes.

Replay tests: `tests/goals.test.ts`. Pure rules: `tests/goal-machine.test.ts`.
