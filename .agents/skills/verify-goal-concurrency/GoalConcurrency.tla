-------------------------- MODULE GoalConcurrency --------------------------
EXTENDS Naturals
CONSTANTS InitialTarget, EditedTarget
VARIABLES target, raised, status, contribution, editor
vars == <<target, raised, status, contribution, editor>>
Init == /\ target = InitialTarget /\ raised = 0 /\ status = "active"
        /\ contribution = "ready" /\ editor = "ready"

\* Entire addContribution BEGIN IMMEDIATE: goal/status SELECT, validation,
\* INSERT, SUM and conditional status UPDATE. The goal read is now protected.
CommitContribution ==
  /\ contribution = "ready" /\ status = "active"
  /\ raised' = raised + 1
  /\ status' = IF raised + 1 >= target THEN "completed" ELSE status
  /\ contribution' = "done"
  /\ UNCHANGED <<target, editor>>
RejectCompletedContribution ==
  /\ contribution = "ready" /\ status = "completed"
  /\ contribution' = "done"
  /\ UNCHANGED <<target, raised, status, editor>>

\* Entire updateGoal BEGIN IMMEDIATE: membership/goal SELECT, SUM SELECT,
\* then one UPDATE writes target and calculated status. No intervening writer.
CommitEditor ==
  /\ editor = "ready" /\ target' = EditedTarget
  /\ status' = IF raised >= EditedTarget THEN "completed" ELSE "active"
  /\ editor' = "done"
  /\ UNCHANGED <<raised, contribution>>
Done == /\ contribution = "done" /\ editor = "done" /\ UNCHANGED vars
Next == CommitContribution \/ RejectCompletedContribution \/ CommitEditor \/ Done
CompletionSound == status = "completed" => raised >= target
CompletionRecognized == raised >= target => status = "completed"
TypeOK == /\ target \in {InitialTarget, EditedTarget} /\ raised \in 0..1
          /\ status \in {"active", "completed"}
=============================================================================
