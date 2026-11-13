---- MODULE Bills ----
\* Model of one recurring bill and the code that posts it.
\* Code: src/lib/store.ts createBill/updateBill/archiveBill/processDueBills, src/lib/bill-scheduler.ts.
\* Dates are small integers. "Day d+1" is the next Manila calendar day. One posting step = one
\* indivisible db.transaction in processDueBills. Weekly/monthly/yearly are all "next date = date + 1":
\* real calendar arithmetic (advanceBillDate) is not modelled.
EXTENDS Naturals

CONSTANTS MaxDay,          \* last day the clock reaches
          AllowDateEdit,   \* TRUE: PATCH may change nextDueDate
          GuardEdit        \* TRUE: an edit may not move nextDueDate to a date already posted (store.ts updateBill)

None == 99
Dates == 0..(MaxDay + 1)
Ends == Dates \cup {None}

VARIABLES today, next, end, archived, cnt, first, acctOK,
          started, armed, run, runDay, cand, lastFailed, bad, regressed
vars == <<today, next, end, archived, cnt, first, acctOK, started, armed, run, runDay, cand, lastFailed, bad, regressed>>

\* today      Manila date now                          next       bills.next_due_date
\* end        bills.end_date (None = no end)           archived   bills.archived_at is set
\* cnt[d]     expense transactions posted for date d   first      first due date when created
\* acctOK     FALSE = posting throws (bad amount, ledger overflow ...)
\* started    startBillScheduler already ran           armed      a setTimeout is pending
\* run        who is inside processDueBills           cand       candidate was due when the run began
\* lastFailed the latest run failed or crashed          bad / regressed  history flags, must stay FALSE

Init ==
  /\ today = 0
  /\ next \in 0..2
  /\ end \in {None} \cup {e \in 0..(MaxDay) : e >= next}
  /\ first = next
  /\ archived = FALSE
  /\ cnt = [d \in Dates |-> 0]
  /\ acctOK = TRUE
  /\ started = FALSE /\ armed = FALSE /\ run = "none" /\ runDay = 0 /\ cand = FALSE
  /\ lastFailed = FALSE /\ bad = FALSE /\ regressed = FALSE

BeginRun(kind, day) ==
  /\ run' = kind /\ runDay' = day
  /\ cand' = (~archived /\ next <= day)       \* the SELECT of due bills
  /\ lastFailed' = FALSE

\* startBillScheduler: first call runs at once, later calls return (started guard).
Start == /\ ~started /\ started' = TRUE /\ run = "none" /\ BeginRun("sched", today)
         /\ UNCHANGED <<today, next, end, archived, cnt, first, acctOK, armed, bad, regressed>>

\* The timer fires at 02:00 Asia/Manila (nextBillRunAt), when the Manila date is already the new day.
Tick == /\ armed /\ run = "none" /\ today < MaxDay
        /\ today' = today + 1 /\ armed' = FALSE /\ BeginRun("sched", today + 1)
        /\ UNCHANGED <<next, end, archived, cnt, first, acctOK, started, bad, regressed>>

\* PATCH /api/bills/[id] calls processDueBills after saving.
ApiRun == /\ run = "none" /\ started /\ BeginRun("api", today)
          /\ UNCHANGED <<today, next, end, archived, cnt, first, acctOK, started, armed, bad, regressed>>

Finish(failed) ==
  /\ run' = "none" /\ cand' = FALSE
  /\ armed' = (armed \/ run = "sched")        \* scheduler re-arms after success, failure and crash
  /\ lastFailed' = (lastFailed \/ failed)

\* One loop iteration of processDueBills, in one transaction.
StepGone == /\ run # "none" /\ (~cand \/ archived \/ next > runDay)
            /\ Finish(FALSE)
            /\ UNCHANGED <<today, next, end, archived, cnt, first, acctOK, started, runDay, bad, regressed>>

StepEnded == /\ run # "none" /\ cand /\ ~archived /\ next <= runDay /\ end # None /\ next > end
             /\ archived' = TRUE /\ Finish(FALSE)
             /\ UNCHANGED <<today, next, end, cnt, first, acctOK, started, runDay, bad, regressed>>

StepFail == /\ run # "none" /\ cand /\ ~archived /\ next <= runDay /\ ~(end # None /\ next > end) /\ ~acctOK
            /\ Finish(TRUE)                    \* rolled back: nothing changes
            /\ UNCHANGED <<today, next, end, archived, cnt, first, acctOK, started, runDay, bad, regressed>>

StepPost == /\ run # "none" /\ cand /\ ~archived /\ next <= runDay /\ ~(end # None /\ next > end) /\ acctOK
            /\ cnt' = [cnt EXCEPT ![next] = @ + 1]
            /\ next' = next + 1
            /\ archived' = (end # None /\ next + 1 > end)
            /\ bad' = (bad \/ archived \/ next > runDay \/ (end # None /\ next > end))
            /\ regressed' = (regressed \/ next + 1 < next)
            /\ UNCHANGED <<today, end, first, acctOK, started, armed, run, runDay, cand, lastFailed>>

\* processDueBills throws outside a bill (database locked): bill-scheduler catches it and re-arms.
Crash == /\ run = "sched" /\ Finish(TRUE)
         /\ UNCHANGED <<today, next, end, archived, cnt, first, acctOK, started, runDay, bad, regressed>>

\* updateBill. expected = the nextDueDate the form was loaded with; a stale one is rejected (no change).
Edit(n, e) ==
  /\ (n = next \/ (AllowDateEdit /\ n >= today))
  /\ (~GuardEdit \/ ~(\E d \in Dates : cnt[d] > 0 /\ d >= n))   \* canScheduleDueDate: n must be after the last posted date
  /\ n \in Dates /\ e \in Ends
  /\ next' = n /\ end' = e
  /\ archived' = (archived \/ (e # None /\ n > e))
  /\ UNCHANGED <<today, cnt, first, acctOK, started, armed, run, runDay, cand, lastFailed, bad, regressed>>

Archive == /\ archived' = TRUE
           /\ UNCHANGED <<today, next, end, cnt, first, acctOK, started, armed, run, runDay, cand, lastFailed, bad, regressed>>

AccountBreaks == /\ acctOK' = ~acctOK
                 /\ UNCHANGED <<today, next, end, archived, cnt, first, started, armed, run, runDay, cand, lastFailed, bad, regressed>>

Next ==
  \/ Start \/ Tick \/ ApiRun \/ StepGone \/ StepEnded \/ StepFail \/ StepPost \/ Crash
  \/ \E n \in Dates, e \in Ends : Edit(n, e)
  \/ Archive \/ AccountBreaks

Spec == Init /\ [][Next]_vars

Bounded == \A d \in Dates : cnt[d] <= 2

TypeOK == /\ next \in Dates /\ end \in Ends /\ archived \in BOOLEAN /\ cnt \in [Dates -> 0..9]

\* Rules (each is one sentence in SKILL.md).
NoPostWhenInactive == ~bad                      \* a bill that is archived, not yet due, or past its end date never posts
NoSilentRegression == ~regressed                \* only a user edit moves nextDueDate backwards
SchedulerRearms == (started /\ run = "none") => armed   \* the 02:00 Manila timer is always pending between runs
NoDoublePost == \A d \in Dates : cnt[d] <= 1    \* one expense per due date
ExactlyOnce == \A d \in Dates : cnt[d] = (IF d >= first /\ d < next THEN 1 ELSE 0)
NoLostDue == (run = "none" /\ started /\ ~lastFailed /\ ~archived) => next > runDay   \* after a clean run nothing due is left
====
