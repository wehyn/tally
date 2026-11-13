-------------------------- MODULE GoalConcurrency --------------------------
EXTENDS Naturals
CONSTANTS InitialTarget, EditedTarget
VARIABLES target, raised, status, contribution, editor, savedTarget, savedRaised
vars == <<target, raised, status, contribution, editor, savedTarget, savedRaised>>
Init == /\ target = InitialTarget /\ raised = 0 /\ status = "active"
        /\ contribution = "ready" /\ editor = "ready"
        /\ savedTarget = 0 /\ savedRaised = 0

\* requireGoalMember's SELECT in addContribution, outside BEGIN IMMEDIATE.
ReadContributionGoal ==
  /\ contribution = "ready" /\ status = "active"
  /\ savedTarget' = target /\ contribution' = "read"
  /\ UNCHANGED <<target, raised, status, editor, savedRaised>>
RejectCompletedContribution ==
  /\ contribution = "ready" /\ status = "completed"
  /\ contribution' = "done"
  /\ UNCHANGED <<target, raised, status, editor, savedTarget, savedRaised>>
\* Entire addContribution .immediate(): insert, SUM, conditional status UPDATE.
\* Saved status is active on this path. If next status is active, no UPDATE runs.
CommitContribution ==
  /\ contribution = "read"
  /\ raised' = raised + 1
  /\ status' = IF raised + 1 >= savedTarget THEN "completed" ELSE status
  /\ contribution' = "done"
  /\ UNCHANGED <<target, editor, savedTarget, savedRaised>>

\* requireGoalMember SELECT in updateGoal: status is read here. Neither active
\* nor completed is terminal, so both give the same nextGoalStatus calculation.
ReadEditorGoal ==
  /\ editor = "ready" /\ editor' = "goal read"
  /\ UNCHANGED <<target, raised, status, contribution, savedTarget, savedRaised>>
\* safeGoalTotal is another autocommit SELECT, NOT in a transaction.
ReadEditorTotal ==
  /\ editor = "goal read" /\ savedRaised' = raised /\ editor' = "total read"
  /\ UNCHANGED <<target, raised, status, contribution, savedTarget>>
\* One UPDATE writes target and status together using the previously read SUM.
CommitEditor ==
  /\ editor = "total read" /\ target' = EditedTarget
  /\ status' = IF savedRaised >= EditedTarget THEN "completed" ELSE "active"
  /\ editor' = "done"
  /\ UNCHANGED <<raised, contribution, savedTarget, savedRaised>>
Done == /\ contribution = "done" /\ editor = "done" /\ UNCHANGED vars
Next == ReadContributionGoal \/ RejectCompletedContribution \/ CommitContribution
        \/ ReadEditorGoal \/ ReadEditorTotal \/ CommitEditor \/ Done
CompletionSound == status = "completed" => raised >= target
CompletionRecognized == raised >= target => status = "completed"
TypeOK == /\ target \in {InitialTarget, EditedTarget} /\ raised \in 0..1
          /\ status \in {"active", "completed"}
=============================================================================
