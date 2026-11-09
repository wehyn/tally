---- MODULE Goals ----
\* Model of one shared goal in Tally. Code: src/lib/lifecycle.ts and src/lib/store.ts
\* (createGoal, inviteToGoal, respondInvitation, updateGoal, succession, changeMembership,
\* addContribution, updateContribution, deleteContribution, deleteAccountOwner, setUserEnabled).
EXTENDS Naturals

CONSTANTS NUsers, NSlots, MaxAmount, MaxTarget, Churn   \* Churn = FALSE leaves out edits, deletes, disabling and account deletion (smaller model for charts)

Users == 1..NUsers          \* user 1 creates the goal and starts as manager
Slots == 1..NSlots          \* at most two contributions exist at once
Amounts == 1..MaxAmount
Targets == 1..MaxTarget
NoOwner == 99          \* contribution whose owner deleted their account (user_id NULL, "Former member")

VARIABLES gstatus, manager, mstat, enabled, alive, target, contrib

vars == <<gstatus, manager, mstat, enabled, alive, target, contrib>>

\* lifecycle.ts nextMembershipStatus table
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

\* lifecycle.ts nextGoalStatus
NextStatus(cur, raised, tgt) ==
  IF cur = "archived" THEN "archived" ELSE IF raised >= tgt THEN "completed" ELSE "active"

\* store.ts succession(): first enabled accepted member other than the outgoing one, else archive.
\* The model picks any such member; the code picks the earliest accepted. Which one does not
\* change any rule checked here.
Successors(out, ms) == {u \in Users : u # out /\ ms[u] = "accepted" /\ enabled[u] /\ alive[u]}

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

\* store.ts respondInvitation: checks only that the row is still 'invited', not the goal status
Respond(u, accept) ==
  /\ mstat[u] = "invited" /\ alive[u]
  /\ mstat' = [mstat EXCEPT ![u] = Move("invited", IF accept THEN "accept" ELSE "decline")]
  /\ UNCHANGED <<gstatus, manager, enabled, alive, target, contrib>>

\* store.ts changeMembership: actor must be an accepted member; remove needs the manager
Change(actor, u, act) ==
  /\ mstat[actor] = "accepted" /\ Move(mstat[u], act) # "illegal"
  /\ IF manager = u
       THEN IF Successors(u, mstat) # {}
              THEN \E n \in Successors(u, mstat) : manager' = n /\ gstatus' = gstatus
              ELSE manager' = 0 /\ gstatus' = "archived"
       ELSE UNCHANGED <<manager, gstatus>>
  /\ mstat' = [mstat EXCEPT ![u] = Move(mstat[u], act)]
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

\* store.ts setUserEnabled: no goal logic runs
ToggleEnabled(u) ==
  /\ alive[u] /\ enabled' = [enabled EXCEPT ![u] = ~@]
  /\ UNCHANGED <<gstatus, manager, mstat, alive, target, contrib>>

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
  /\ mstat' = [mstat EXCEPT ![u] = IF @ = "none" THEN "none" ELSE "former"]
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

\* ---- Rules that currently break (see SKILL.md, Findings) ----
\* A live goal's manager is an enabled user.
ManagerIsEnabled == gstatus # "archived" => enabled[manager]

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
====
