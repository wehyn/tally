# Goals state machines

Verified by `.claude/skills/verify-goals` (TLA+ model, sync commit `c006c65`).

## Inventory

| Machine | States | Legal moves (guard) |
|---|---|---|
| Goal status | `active`, `completed`, `archived` | `nextGoalStatus` (`src/lib/lifecycle.ts:8`): archived is terminal; otherwise completed iff raised ≥ target. Recomputed on contribution add/edit/delete (`store.ts:1153, 1173, 1184`) and target change (`store.ts:1124`). Archived is set only by `succession` (`store.ts:1131`). |
| Membership | none, `invited`, `accepted`, `left`, `removed`, `former` | `MEMBERSHIP_MOVES` (`lifecycle.ts:27`): invite from none/left/removed; accept/decline from invited; leave/remove from accepted. `former` only by account deletion (`store.ts:1204`). |
| Manager | a user, or none | Set at `createGoal` (`store.ts:1063`); changed only by `succession` (`store.ts:1127`) from `changeMembership` (`:1133`) and `deleteAccountOwner` (`:1200`). |
| Contribution | exists / deleted; owner or "Former member" | Add needs an accepted member and an `active` goal (`store.ts:1145`); edit and delete need the owner to be an accepted member (`:1158`, `:1177`). |

## Main flow: invite, contribute, complete, hand over

Two people; person 1 manages. Chart from `goals-flow.cfg` (132 model states, 38 arrows; edits, disabling and account deletion left out; steps that stay in one state are not drawn).

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

## Rules that hold (all 7 pass, 292,512 states)

Manager matches status; completed iff target met; former members own nothing; membership moves only along the table; contributions only while active; archived is terminal.

## Findings

1. **Stale invitation accepted after archive** (rule: an archived goal has no accepted member). Path: manager invites → manager leaves (goal archived) → invitee accepts. `respondInvitation` (`store.ts:1100`) ignores goal status. Low impact.
2. **Disabled manager stays manager** (rule: a live goal's manager is enabled). Path: admin disables the manager → goal active, manager cannot sign in. `setUserEnabled` (`store.ts:334`) has no succession. Medium impact: nobody else can manage the goal.

Both replay against the real store in `.claude/skills/verify-goals/replay/goals-replay.test.ts`.
