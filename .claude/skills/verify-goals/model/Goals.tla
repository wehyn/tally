---- MODULE Goals ----
\* Model of one shared goal in Tally. Code: src/lib/machines/goal.ts and src/lib/store.ts
\* (createGoal, inviteToGoal, respondInvitation, updateGoal, succession, handOverFromDisabledManager,
\* changeMembership, addContribution, updateContribution, deleteContribution, deleteAccountOwner, setUserEnabled).
EXTENDS Naturals

CONSTANTS NUsers, NSlots, MaxAmount, MaxTarget, Churn   \* Churn = FALSE leaves out edits, deletes, disabling and account deletion (smaller model for charts)
CONSTANT DisableRule   \* "keep" is the code. "archive" and "ignore" replay broken rules (goals-archive-on-disable.cfg, goals-no-handover.cfg)

Users == 1..NUsers          \* user 1 creates the goal and starts as manager
Slots == 1..NSlots          \* at most two contributions exist at once
Amounts == 1..MaxAmount
Targets == 1..MaxTarget
NoOwner == 99          \* contribution whose owner deleted their account (user_id NULL, "Former member")

VARIABLES gstatus, manager, mstat, enabled, alive, target, contrib

vars == <<gstatus, manager, mstat, enabled, alive, target, contrib>>

\* machines/goal.ts nextMembershipStatus table
Move(cur, act) ==
  CASE act = "invite"  -> IF cur \in {"none", "left", "removed"} THEN "invited" ELSE "illegal"
    [] act = "accept"  -> IF cur = "invited" THEN "accepted" ELSE "illegal"
    [] act = "decline" -> IF cur = "invited" THEN "left" ELSE "illegal"
    [] act = "leave"   -> IF cur = "accepted" THEN "left" ELSE "illegal"
    [] act = "remove"  -> IF cur = "accepted" THEN "removed" ELSE "illegal"

RECURSIVE SumOf(_)
SumOf(S) == IF S = {} THEN 0 ELSE LET s == CHOOSE x \in S : TRUE IN contrib[s].amt + SumOf(S \ {s})
\* SUM(amount_minor) over all contributions
Raised == SumOf(Slots)

\* machines/goal.ts nextGoalStatus
NextStatus(cur, raised, tgt) ==
  IF cur = "archived" THEN "archived" ELSE IF raised >= tgt THEN "completed" ELSE "active"

\* machines/goal.ts decideSuccession: first enabled accepted member other than the outgoing one.
\* None means a leaving, removed or deleted manager archives the goal and a disabled manager changes nothing.
\* The model picks any such member; the code picks the earliest accepted. Which one does not
\* change any rule checked here.
SuccessorsIn(out, ms, en) == {u \in Users : u # out /\ ms[u] = "accepted" /\ en[u] /\ alive[u]}
Successors(out, ms) == SuccessorsIn(out, ms, enabled)

\* store.ts succession, archive branch: every accepted membership closes ("left").
\* Only the archive branch changes membership; a hand-over leaves memberships alone.
Close(out, ms) == [v \in Users |-> IF ms[v] = "accepted" THEN "left" ELSE ms[v]]

Init ==
  /\ gstatus = "active" /\ manager = 1 /\ target \in Targets
  /\ mstat = [u \in Users |-> IF u = 1 THEN "accepted" ELSE "none"]
  /\ enabled = [u \in Users |-> TRUE] /\ alive = [u \in Users |-> TRUE]
  /\ contrib = [s \in Slots |-> [amt |-> 0, owner |-> 0]]

\* store.ts inviteToGoal
Invite(m, u) ==
  /\ manager = m /\ mstat[m] = "accepted" /\ u # m /\ enabled[u] /\ alive[u]
  /\ Move(mstat[u], "invite") # "illegal"
  /\ mstat' = [mstat EXCEPT ![u] = "invited"]
  /\ UNCHANGED <<gstatus, manager, enabled, alive, target, contrib>>

\* store.ts respondInvitation: the row must still be 'invited'; accept is refused once the goal is archived.
\* An accept can give a disabled manager an enabled accepted member, who then takes over (handOverFromDisabledManager).
Respond(u, accept) ==
  LET ms == [mstat EXCEPT ![u] = Move("invited", IF accept THEN "accept" ELSE "decline")]
  IN /\ mstat[u] = "invited" /\ alive[u]
     /\ ~(accept /\ gstatus = "archived")
     /\ mstat' = ms
     /\ IF accept /\ gstatus # "archived" /\ ~enabled[manager] /\ SuccessorsIn(manager, ms, enabled) # {}
          THEN \E n \in SuccessorsIn(manager, ms, enabled) : manager' = n
          ELSE manager' = manager
     /\ UNCHANGED <<gstatus, enabled, alive, target, contrib>>

\* store.ts changeMembership: actor must be an accepted member; remove needs the manager
Change(actor, u, act) ==
  /\ mstat[actor] = "accepted" /\ Move(mstat[u], act) # "illegal"
  /\ IF manager = u
       THEN IF Successors(u, mstat) # {}
              THEN \E n \in Successors(u, mstat) : manager' = n /\ gstatus' = gstatus
              ELSE manager' = 0 /\ gstatus' = "archived"
       ELSE UNCHANGED <<manager, gstatus>>
  /\ mstat' = [v \in Users |->
       IF v = u THEN Move(mstat[u], act)
       ELSE IF manager = u /\ Successors(u, mstat) = {} THEN Close(u, mstat)[v] ELSE mstat[v]]
  /\ UNCHANGED <<enabled, alive, target, contrib>>

Leave(u) == Change(u, u, "leave")
Remove(m, u) == manager = m /\ Change(m, u, "remove")

\* store.ts addContribution: accepted member, goal must be active
AddContribution(u, s, a) ==
  /\ mstat[u] = "accepted" /\ gstatus = "active" /\ contrib[s].amt = 0
  /\ contrib' = [contrib EXCEPT ![s] = [amt |-> a, owner |-> u]]
  /\ gstatus' = NextStatus(gstatus, Raised + a, target)
  /\ UNCHANGED <<manager, mstat, enabled, alive, target>>

\* store.ts updateContribution: only the owner, still accepted; status recomputed
UpdateContribution(u, s, a) ==
  /\ contrib[s].owner = u /\ mstat[u] = "accepted" /\ a # contrib[s].amt
  /\ contrib' = [contrib EXCEPT ![s].amt = a]
  /\ gstatus' = NextStatus(gstatus, Raised - contrib[s].amt + a, target)
  /\ UNCHANGED <<manager, mstat, enabled, alive, target>>

\* store.ts deleteContribution
DeleteContribution(u, s) ==
  /\ contrib[s].owner = u /\ mstat[u] = "accepted"
  /\ contrib' = [contrib EXCEPT ![s] = [amt |-> 0, owner |-> 0]]
  /\ gstatus' = NextStatus(gstatus, Raised - contrib[s].amt, target)
  /\ UNCHANGED <<manager, mstat, enabled, alive, target>>

\* store.ts updateGoal (target change). Manager must be an accepted member.
RaiseOrLowerTarget(m, t) ==
  /\ manager = m /\ mstat[m] = "accepted" /\ t # target
  /\ target' = t
  /\ gstatus' = NextStatus(gstatus, Raised, t)
  /\ UNCHANGED <<manager, mstat, enabled, alive, contrib>>

\* store.ts setUserEnabled: flips the flag, then handOverFromDisabledManager. A disabled manager hands the goal to an
\* enabled accepted member when one exists, after a disable and after an enable. With none, nothing changes: the goal,
\* its manager and its memberships wait for the re-enable. DisableRule "archive" replays the earlier rule, which archived
\* the goal and closed every accepted membership; "ignore" replays the rule before that, which did nothing at all.
ToggleEnabled(u) ==
  LET en == [enabled EXCEPT ![u] = ~enabled[u]]
  IN /\ alive[u]
     /\ enabled' = en
     /\ IF DisableRule = "archive" /\ enabled[u] /\ manager = u /\ gstatus # "archived" /\ SuccessorsIn(u, mstat, en) = {}
          THEN /\ manager' = 0 /\ gstatus' = "archived" /\ mstat' = Close(u, mstat)
          ELSE /\ IF DisableRule # "ignore" /\ gstatus # "archived" /\ ~en[manager] /\ SuccessorsIn(manager, mstat, en) # {}
                    THEN \E n \in SuccessorsIn(manager, mstat, en) : manager' = n
                    ELSE manager' = manager
               /\ UNCHANGED <<gstatus, mstat>>
     /\ UNCHANGED <<alive, target, contrib>>

\* store.ts deleteAccountOwner: succession for a managed non-archived goal, contributions and
\* membership become "Former member"
DeleteAccount(u) ==
  /\ alive[u]
  /\ IF manager = u /\ gstatus # "archived"
       THEN IF Successors(u, mstat) # {}
              THEN \E n \in Successors(u, mstat) : manager' = n /\ gstatus' = gstatus
              ELSE manager' = 0 /\ gstatus' = "archived"
       ELSE UNCHANGED <<manager, gstatus>>
  /\ alive' = [alive EXCEPT ![u] = FALSE]
  /\ mstat' = [v \in Users |->
       IF v = u THEN IF mstat[u] = "none" THEN "none" ELSE "former"
       ELSE IF manager = u /\ gstatus # "archived" /\ Successors(u, mstat) = {} THEN Close(u, mstat)[v] ELSE mstat[v]]
  /\ contrib' = [s \in Slots |-> IF contrib[s].owner = u THEN [contrib[s] EXCEPT !.owner = NoOwner] ELSE contrib[s]]
  /\ UNCHANGED <<enabled, target>>

\* End state (archived goal): a self-step so it is not a deadlock
Done == gstatus = "archived" /\ UNCHANGED vars

Next ==
  \/ \E m, u \in Users : Invite(m, u)
  \/ \E u \in Users, b \in BOOLEAN : Respond(u, b)
  \/ \E u \in Users : Leave(u)
  \/ \E m, u \in Users : Remove(m, u)
  \/ \E u \in Users, s \in Slots, a \in Amounts : AddContribution(u, s, a)
  \/ Churn /\ \E u \in Users, s \in Slots, a \in Amounts : UpdateContribution(u, s, a)
  \/ Churn /\ \E u \in Users, s \in Slots : DeleteContribution(u, s)
  \/ \E m \in Users, t \in Targets : RaiseOrLowerTarget(m, t)
  \/ Churn /\ \E u \in Users : ToggleEnabled(u)
  \/ Churn /\ \E u \in Users : DeleteAccount(u)
  \/ Done

Spec == Init /\ [][Next]_vars

\* ---- Rules that must hold ----
TypeOK ==
  /\ gstatus \in {"active", "completed", "archived"}
  /\ manager \in Users \cup {0}
  /\ \A u \in Users : mstat[u] \in {"none", "invited", "accepted", "left", "removed", "former"}

\* An archived goal has no manager; a live goal's manager is an accepted member who still exists.
ManagerMatchesStatus ==
  /\ (gstatus = "archived") <=> (manager = 0)
  /\ gstatus # "archived" => (mstat[manager] = "accepted" /\ alive[manager])

\* A live goal is completed exactly when contributions meet the target.
CompletedIffTargetMet ==
  gstatus # "archived" => ((gstatus = "completed") <=> (Raised >= target))

\* A deleted account owns nothing and is never a manager.
FormerMembersOwnNothing ==
  \A u \in Users : ~alive[u] =>
    /\ mstat[u] \in {"none", "former"} /\ manager # u
    /\ \A s \in Slots : contrib[s].owner # u

\* ---- Rules that hold after the fixes (see SKILL.md, Findings) ----
\* A live goal's manager is enabled, unless nobody else can take over: disabling a manager with no enabled
\* accepted member to hand to leaves the goal untouched, so enabling them restores it.
ManagerIsEnabledUnlessAlone ==
  gstatus # "archived" => (enabled[manager] \/ SuccessorsIn(manager, mstat, enabled) = {})

\* An archived goal has no accepted members: nobody can join a goal that no longer has a manager.
ArchivedGoalHasNoAcceptedMember ==
  gstatus = "archived" => \A u \in Users : mstat[u] # "accepted"

\* ---- Step rules ----
LegalMembershipMoves ==
  [][\A u \in Users : mstat'[u] # mstat[u] =>
      \/ Move(mstat[u], "invite") = mstat'[u] \/ Move(mstat[u], "accept") = mstat'[u]
      \/ Move(mstat[u], "decline") = mstat'[u] \/ Move(mstat[u], "leave") = mstat'[u]
      \/ Move(mstat[u], "remove") = mstat'[u]
      \/ (mstat'[u] = "former" /\ ~alive'[u])]_vars

NoContributionUnlessActive ==
  [][\A s \in Slots : (contrib[s].amt = 0 /\ contrib'[s].amt > 0) => gstatus = "active"]_vars

ArchivedIsTerminal == [][gstatus = "archived" => gstatus' = "archived"]_vars

\* Disabling or enabling a user never archives a goal or closes a membership. A goal archives only when its manager
\* leaves, is removed by the manager or deletes their account (and the goal has no one to hand to).
TogglingNeverArchives == [][enabled' # enabled => (gstatus' = gstatus /\ mstat' = mstat)]_vars
====
