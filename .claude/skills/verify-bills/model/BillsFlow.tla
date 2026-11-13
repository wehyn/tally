---- MODULE BillsFlow ----
\* Small slice of Bills for drawing the main user flow: no edits, no manual archive, no crash.
EXTENDS Bills
FlowInit == Init /\ next = 1 /\ end \in {None, 2}
FlowNext == Start \/ Tick \/ StepGone \/ StepEnded \/ StepFail \/ StepPost \/ AccountBreaks
FlowSpec == FlowInit /\ [][FlowNext]_vars
====
