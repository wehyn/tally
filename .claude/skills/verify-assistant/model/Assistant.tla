---------------------------- MODULE Assistant ----------------------------
\* One Ask Tally conversation, as runAssistantPrompt (src/lib/assistant.ts) drives it.
\* A turn has two parts. Before the provider answers, nothing is stored: the turn reads the stored
\* follow-up and waits for the model. After it answers, the user message, the write (if any) and the
\* reply commit in one store transaction (commitTurn). Consent and the chat are checked again at commit.
\* The only interleaving points are the awaited provider call and separate HTTP requests.
\*
\* A pending question ends in three ways. An exact cancel drops it (pendingOutcome, src/lib/machines/assistant.ts):
\* the whole prompt, normalized, equals one of a few phrases. An answer that resolves it ends it, and so does a
\* completed write. Every other reply keeps the question and runs the existing cautious handling, which asks again
\* and writes nothing when the reply is not a clean answer. A turn that only reads (the debt list, a finance
\* answer) is none of the three, so it leaves the question exactly as it was (followupAfterTurn, same file).
\* Deciding from free text that a reply was a new request was tried four times and abandoned (see the doc).
\*
\* A turn may commit only while the conversation still ends at the message it read (turnMayCommit). A second
\* request that commits first, an answer sent twice or a cancel that finishes while the model is still answering,
\* makes the slower turn stale. It stores nothing and the user is told to send it again (409). Rival models that
\* other request as one whole turn that reads, waits and commits while ours is in flight, which covers every
\* order in which two requests can commit. race.cfg drops the check (Unchecked = TRUE, the code at 326d565).
\*
\* Legacy = TRUE replays the rules before the fixes (user message stored before the call, no re-check
\* at commit, no way to drop a pending question). findings.cfg runs that variant and must fail.
\* Doubt = TRUE replays the older replace-on-text rule (232f564, then 7f0e42f), which let a hedged reply, an
\* amount with a detail or a complete request replace a pending question, so "maybe 500", "500 cash" and
\* "Coffee 120" dropped it. doubt.cfg runs that variant and must fail on AnswerNotReplaced.
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxReqs,    \* bound on prompts sent in one run
    Intents,    \* which kinds of user prompt may be sent (subset of AllIntents)
    Env,        \* TRUE: consent revoke/stale and chat delete may interleave with a request
    Clock,      \* TRUE: the ten-second Undo window may expire
    Fails,      \* TRUE: the provider call may fail
    Legacy,     \* TRUE: the pre-fix rules (see the header)
    Doubt,      \* TRUE: a text-classified reply replaces a pending question, as at 232f564 and 7f0e42f (see the header)
    Rivals,     \* TRUE: another request on the same conversation may commit while a turn waits on the model
    Unchecked   \* TRUE: a turn commits without checking that the conversation is where it read it (326d565, see the header)

AllIntents == {"plain", "cancel", "uncertainPay", "debtPay", "debtPayNoAmount", "noMatchPay", "amount", "amountDetail", "hedgedAnswer", "yes", "readOnly"}
\* plain            "Jollibee lunch 250", "she paid back the food money, 500", "siguro Food 500": any prompt that
\*                  is not an answer to the pending question and not a cancel. At a pending repayment or
\*                  income question it is asked again and writes nothing, however much it looks like a new
\*                  request. That is the deliberate limitation, not an invariant. With nothing pending it is
\*                  an ordinary prompt, and so is a cancel, which is why cancel is only sent while a question is pending.
\* cancel           the exact cancel phrase ("cancel", "never mind", "skip", "forget it", "stop", "wag na"...)
\* uncertainPay     "maybe Ana paid me?": negated or uncertain payment wording
\* debtPay          "Ana paid me 500" and Ana has one open debt: confirmed repayment
\* debtPayNoAmount  "Ana paid me": payer known, amount missing
\* noMatchPay       "Zed paid me 500", no open debt for Zed
\* amount           an amount the strict reading accepts: digits with an optional peso sign or word and
\*                  nothing else ("500", "1,000.50", "500 pesos")
\* amountDetail     any other reply with a number and no hedge: "500 cash", "5k", "P500", "500 sa GCash",
\*                  "about 500", "500 last night". After a repayment amount question it is not read as
\*                  an amount, so the question is asked again.
\* hedgedAnswer     a reply that hedges or negates: "maybe 500", "I think 500", "not 500", "500?"
\* yes              a bare "yes"
\* readOnly         "List my debts" or "How much did I spend this month?", answered from the ledger. It writes nothing
\*                  and asks nothing. It is not an answer and not a cancel, so a pending question stays pending. With
\*                  nothing pending it is an ordinary turn.
Kinds == {"none", "clarification", "ordinary_income", "repayment_amount", "repayment_payer"}

VARIABLES
    access,        \* "on" | "off" | "stale": opt-in with the current disclosure hash (getAssistantConsent)
    conv,          \* "live" | "gone": conversation row exists (deleteConversation)
    pend,          \* follow-up kind stored on the last assistant message
    last,          \* "reply": last stored message is an assistant question or answer; "wrote": a reply that saved a transaction; "orphan": last is the user's (Legacy only)
    phase,         \* "idle" | "saved" (provider in flight) | "errored"
    intent, pendAtStart,
    written,       \* ledger writes made for the user's current intent
    ledger,        \* assistant-written transactions currently stored
    undo,          \* "none" | "open" | "expired" | "used": the last assistant transaction's Undo window
    txKind,        \* "none" | "plain" | "repayment"
    reqs,
    since,         \* what other requests did to the conversation while the turn in flight waited. "same" means nothing, so its
                   \* last message is still the one it read. "answered" or "dropped" means the first commit since answered the
                   \* question it read with a write, or a cancel dropped it. "other" means any other commit
    \* sticky witnesses, one per rule
    wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
    answeredTwice, answeredAfterCancel
vars == <<access, conv, pend, last, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs, since,
          wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
          answeredTwice, answeredAfterCancel>>

\* pendingOutcome (src/lib/machines/assistant.ts): with a question pending, only an exact cancel phrase drops
\* it. Every other reply answers, whatever its wording, so an amount reply, an amount with a detail, a hedged
\* reply and a request that looks new never drop it. "replace" exists only in the Doubt variant, the older
\* rule that read free text, which then ran the turn with no prior context.
Outcome(i, p) ==
    IF p = "none" THEN "answer"
    ELSE IF ~Legacy /\ i = "cancel" THEN "cancel"
    ELSE IF Doubt /\ i \in {"plain", "amountDetail", "hedgedAnswer"} /\ p \in {"repayment_amount", "repayment_payer", "ordinary_income"}
    THEN "replace" ELSE "answer"
Effective(i, p) == IF Outcome(i, p) = "replace" THEN "none" ELSE p

\* What the code decides for (intent, follow-up the turn answers). Mirrors the override chain in assistant.ts
\* runAssistantPrompt (ordinaryIncomeFlow, uncertainRepayment, repaymentIntent) and the per-tool branches below it.
Decision(i, p) ==
    CASE i = "plain" ->
            IF p \in {"repayment_amount", "repayment_payer", "ordinary_income"}
            THEN [out |-> "ask", next |-> p]                          \* ordinaryIncomeFlow or the bare amount re-asks the question and writes nothing
            ELSE [out |-> "wplain", next |-> "none"]
      [] i = "cancel" ->
            IF p = "none" THEN [out |-> "ask", next |-> "clarification"]   \* nothing pending: an ordinary prompt
            ELSE IF Legacy THEN [out |-> "ask", next |-> p]                \* before the fix nothing could drop a question
            ELSE [out |-> "cancelled", next |-> "none"]                    \* no model call, nothing written, question cleared
      [] i = "uncertainPay"   -> [out |-> "ask",    next |-> "none"]                \* uncertainRepayment branch
      [] i = "debtPay"        -> [out |-> "wrepay", next |-> "none"]                \* repaymentIntent branch, record_debt_repayment
      [] i = "debtPayNoAmount"-> [out |-> "ask",    next |-> "repayment_amount"]    \* repaymentIntent branch, no stated amount
      [] i = "noMatchPay"     -> [out |-> "ask",    next |-> "ordinary_income"]     \* repaymentIntent branch, no matching debt
      [] i = "amount"         ->
            IF p = "repayment_amount"
            THEN [out |-> "wrepay", next |-> "none"]                   \* bareAmountFromPrompt
            ELSE [out |-> "ask", next |-> "clarification"]
      [] i = "amountDetail"   ->
            IF p = "repayment_amount"
            THEN [out |-> "ask", next |-> p]                           \* strict amount reading fails: asks again, writes nothing
            ELSE IF p = "ordinary_income"
            THEN [out |-> "ask", next |-> p]                           \* re-asks the income question
            ELSE [out |-> "ask", next |-> "clarification"]
      [] i = "hedgedAnswer"   ->
            IF p \in {"repayment_amount", "repayment_payer"}
            THEN [out |-> "ask", next |-> "none"]                      \* uncertainRepayment: asks, writes nothing, clears the question
            ELSE IF p = "ordinary_income"
            THEN [out |-> "ask", next |-> p]
            ELSE [out |-> "ask", next |-> "clarification"]
      [] i = "yes"            ->
            IF p = "ordinary_income"
            THEN [out |-> "word", next |-> "none"]                     \* ordinaryIncomeFlow branch
            ELSE [out |-> "ask", next |-> "clarification"]
      [] i = "readOnly"       -> [out |-> "read", next |-> p]                       \* debt-list branch or finance answer: followupAfterTurn keeps the question

\* store.ts deleteTransaction(undoOnly): a debt-linked row never deletes; otherwise only
\* inside the ten-second window.
CodeAllowsUndo(window, kind) == window = "open" /\ kind # "repayment"

\* commitTurn re-checks consent (assertAssistantAccess) and the chat (lastMessageId, addMessage) before it writes.
CommitOk == access = "on" /\ conv = "live"
\* ... and that the conversation still ends at the message the turn read (turnMayCommit). Unchecked drops this one.
Fresh == Unchecked \/ since = "same"

Init ==
    /\ access = "on" /\ conv = "live" /\ pend = "none" /\ last = "reply" /\ phase = "idle"
    /\ intent = "plain" /\ pendAtStart = "none" /\ written = 0 /\ ledger = 0
    /\ undo = "none" /\ txKind = "none" /\ reqs = 0
    /\ since = "same"
    /\ wroteNoConsent = FALSE /\ lostFollowup = FALSE /\ trapped = FALSE
    /\ badUndo = FALSE /\ ordNoQuestion = FALSE /\ wroteUncertain = FALSE /\ answerReplaced = FALSE /\ wroteNonAnswer = FALSE
    /\ answeredTwice = FALSE /\ answeredAfterCancel = FALSE

\* The route: assertAssistantAccess, then the turn reads the stored follow-up and the last message, and waits for the model.
Send(i, fresh) ==
    /\ access = "on" /\ conv = "live" /\ reqs < MaxReqs
    /\ intent' = i /\ reqs' = reqs + 1 /\ phase' = "saved" /\ since' = "same"
    /\ written' = IF fresh THEN 0 ELSE written
    /\ IF Legacy
       THEN \* the user message was stored before the call, so the stored follow-up was no longer last
            /\ pendAtStart' = IF last # "orphan" THEN pend ELSE "none"
            /\ pend' = "none" /\ last' = "orphan"
       ELSE /\ pendAtStart' = pend /\ pend' = pend /\ last' = last
    /\ UNCHANGED <<access, conv, ledger, undo, txKind, wroteNoConsent, lostFollowup, trapped,
                   badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer, answeredTwice, answeredAfterCancel>>

YouSend(i) == i \in Intents /\ phase = "idle" /\ (i = "cancel" => pend # "none") /\ Send(i, TRUE)
YouResend == phase = "errored" /\ Send(intent, FALSE)

\* What a committed turn does to the stored conversation. i is its intent, p the question it read and s what other
\* commits did to that question since (the since variable for our own turn, "same" for a rival that read the current
\* state). Our own turn (ProviderOk) and a rival request (Rival) commit the same way. replyStored is FALSE only for
\* Legacy with the chat gone, where the write happened and the reply insert threw. Only a turn that commits without
\* the check (Unchecked) can have s other than "same".
Effects(i, p, s, replyStored) ==
    LET d == Decision(i, Effective(i, p))
        writes == d.out \in {"wplain", "wrepay", "word"}
    IN /\ ledger' = IF writes THEN ledger + 1 ELSE ledger
       /\ txKind' = CASE d.out = "wrepay" -> "repayment"
                     [] writes -> "plain"
                     [] OTHER -> txKind
       /\ undo' = CASE d.out = "wrepay" -> "none"      \* recordDebtPayment: undoUntil null
                     [] writes -> IF replyStored THEN "open" ELSE "none"   \* Legacy: the client never got the handle
                     [] OTHER -> undo
       /\ wroteNoConsent' = (wroteNoConsent \/ (writes /\ access # "on"))
       /\ ordNoQuestion'  = (ordNoQuestion \/ (d.out = "word" /\ p # "ordinary_income"))
       /\ wroteUncertain' = (wroteUncertain \/ (writes /\ i = "uncertainPay"))
       /\ trapped' = (trapped \/ (i = "cancel" /\ p # "none" /\ d.next # "none"))
       /\ answerReplaced' = (answerReplaced \/ (i # "cancel" /\ Outcome(i, p) # "answer")
                                              \/ (i = "readOnly" /\ p # "none" /\ d.next # p))
       /\ wroteNonAnswer' = (wroteNonAnswer \/ (writes /\ p \in {"repayment_amount", "repayment_payer", "ordinary_income"}
                                               /\ i \in {"plain", "amountDetail", "hedgedAnswer", "cancel"}))
       \* a write that answers a question some commit since already answered, or that a cancel already dropped
       /\ answeredTwice' = (answeredTwice \/ (writes /\ p # "none" /\ s = "answered"))
       /\ answeredAfterCancel' = (answeredAfterCancel \/ (writes /\ p # "none" /\ s = "dropped"))
       /\ IF replyStored
          THEN /\ last' = (IF writes THEN "wrote" ELSE "reply") /\ pend' = d.next
          ELSE /\ last' = "orphan" /\ pend' = "none"   \* Legacy: the reply insert throws, 404

\* The provider answered. The user message, the write (if any) and the reply commit together.
\* A refused commit (consent, chat, or a conversation that moved on) stores nothing. Legacy writes first
\* and then fails at the reply insert.
ProviderOk ==
    /\ phase = "saved"
    /\ IF ~Legacy /\ ~(CommitOk /\ Fresh)
       THEN /\ phase' = "errored" /\ since' = "same"
            /\ UNCHANGED <<access, conv, pend, last, intent, pendAtStart, written, ledger, undo, txKind, reqs,
                           wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
                           answeredTwice, answeredAfterCancel>>
       ELSE LET d == Decision(intent, Effective(intent, pendAtStart))
                writes == d.out \in {"wplain", "wrepay", "word"}
                replyStored == conv = "live"
            IN /\ Effects(intent, pendAtStart, since, replyStored)
               /\ written' = IF writes THEN written + 1 ELSE written
               /\ phase' = IF replyStored THEN "idle" ELSE "errored"
               /\ since' = "same"
               /\ UNCHANGED <<access, conv, intent, pendAtStart, reqs, lostFollowup, badUndo>>

\* Another request on the same conversation, started and answered while ours waits for the model. It commits like
\* any turn (it read the stored state, so its question is the current one) and moves the conversation on. Its
\* own failure or refusal changes nothing, so only a commit is modeled. Legacy stored the user message before
\* the call, which this does not replay.
Rival(i) ==
    /\ Rivals /\ ~Legacy /\ phase = "saved" /\ reqs < MaxReqs /\ CommitOk
    /\ i \in Intents /\ (i = "cancel" => pend # "none")
    /\ Effects(i, pend, "same", TRUE)
    /\ LET d == Decision(i, Effective(i, pend))
       IN since' = IF since # "same" THEN since                  \* the first commit since our turn read decides what became of its question
                   ELSE IF pendAtStart = "none" THEN "other"
                   ELSE IF d.out \in {"wplain", "wrepay", "word"} THEN "answered"
                   ELSE IF d.out = "cancelled" THEN "dropped" ELSE "other"
    /\ reqs' = reqs + 1
    /\ UNCHANGED <<access, conv, phase, intent, pendAtStart, written, lostFollowup, badUndo>>

\* A cancel at a pending question makes no model call (runAssistantPrompt returns before askProvider), so the
\* provider cannot fail it. Its commit can still be refused, which ProviderOk models.
CancelTurn == ~Legacy /\ intent = "cancel" /\ pendAtStart # "none"

ProviderFail ==
    /\ Fails /\ phase = "saved" /\ ~CancelTurn
    /\ phase' = "errored" /\ since' = "same"
    \* a failed call must not change the question. Another request that committed meanwhile may have, and that is not this failure
    /\ lostFollowup' = (lostFollowup \/ (IF Legacy THEN pendAtStart # "none" ELSE conv = "live" /\ since = "same" /\ pend # pendAtStart))
    /\ UNCHANGED <<access, conv, pend, last, intent, pendAtStart, written, ledger, undo, txKind, reqs,
                   wroteNoConsent, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
                   answeredTwice, answeredAfterCancel>>

GiveUp == phase = "errored" /\ phase' = "idle" /\ UNCHANGED <<access, conv, pend, last, intent, pendAtStart, written, ledger, undo, txKind, reqs, since,
                                                             wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
                                                             answeredTwice, answeredAfterCancel>>

NewChat ==
    /\ conv = "gone" /\ phase # "saved"
    /\ conv' = "live" /\ pend' = "none" /\ last' = "reply"
    /\ UNCHANGED <<access, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs, since, wroteNoConsent,
                   lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer, answeredTwice, answeredAfterCancel>>

\* Undo is attempted whenever a transaction exists; the code decides.
YouUndo ==
    /\ undo \in {"open", "expired"} \/ txKind = "repayment"
    /\ IF CodeAllowsUndo(undo, txKind)
       THEN /\ undo' = "used" /\ ledger' = ledger - 1 /\ written' = IF written > 0 THEN written - 1 ELSE 0
            /\ badUndo' = (badUndo \/ undo # "open" \/ txKind = "repayment")   \* deleted outside the window, or a repayment
       ELSE /\ badUndo' = badUndo /\ UNCHANGED <<undo, ledger, written>>   \* the store throws
    /\ UNCHANGED <<access, conv, pend, last, phase, intent, pendAtStart, txKind, reqs, since, wroteNoConsent,
                   lostFollowup, trapped, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer, answeredTwice, answeredAfterCancel>>

ClockExpires ==
    /\ Clock /\ undo = "open" /\ undo' = "expired"
    /\ UNCHANGED <<access, conv, pend, last, phase, intent, pendAtStart, written, ledger, txKind, reqs, since,
                   wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
                   answeredTwice, answeredAfterCancel>>

SetAccess(a) ==
    /\ Env /\ access # a /\ access' = a
    /\ UNCHANGED <<conv, pend, last, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs, since,
                   wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
                   answeredTwice, answeredAfterCancel>>

DeleteChat ==
    /\ Env /\ conv = "live" /\ conv' = "gone" /\ pend' = "none"
    /\ UNCHANGED <<access, last, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs, since,
                   wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain, answerReplaced, wroteNonAnswer,
                   answeredTwice, answeredAfterCancel>>

\* A finished run: nothing more to send. Keeps TLC from reporting a stuck state as a deadlock.
Done == reqs = MaxReqs /\ phase # "saved" /\ UNCHANGED vars

Next ==
    \/ \E i \in AllIntents : YouSend(i)
    \/ \E i \in AllIntents : Rival(i)
    \/ YouResend \/ ProviderOk \/ ProviderFail \/ GiveUp \/ NewChat \/ YouUndo
    \/ ClockExpires \/ SetAccess("off") \/ SetAccess("stale") \/ SetAccess("on") \/ DeleteChat
    \/ Done

Spec == Init /\ [][Next]_vars

\* ---- Rules the code upholds (core.cfg and findings.cfg) -----------------------------------------
UncertainNeverWrites  == ~wroteUncertain      \* negated or uncertain payment wording never writes
RepaymentNoUndo       == txKind = "repayment" => undo = "none"
UndoOnlyInWindow      == ~badUndo             \* no Undo after expiry or on a repayment
OrdinaryIncomeAsked   == ~ordNoQuestion       \* a bare yes writes income only after the question
ReplyConsumesFollowup == last = "wrote" => pend = "none"   \* a saving reply leaves no question pending
NoDuplicateIntentWrite == written <= 1       \* one user intent, at most one transaction
WriteNeedsConsent      == ~wroteNoConsent    \* no transaction after consent was withdrawn
FollowupSurvivesError  == ~lostFollowup      \* a failed provider call keeps the pending question
PlainPromptNotTrapped  == ~trapped           \* an explicit cancel always clears the pending question. An unrelated prompt re-asks (a deliberate limit, not checked)
AnswerNotReplaced      == ~answerReplaced    \* only an explicit cancel drops the pending question, whatever any other reply says, and a turn that only reads leaves it pending
NonAnswerNeverWrites   == ~wroteNonAnswer    \* at a pending repayment or income question, a reply that is not its answer (or a confirmed payment) writes nothing
OneWritePerQuestion    == ~answeredTwice     \* a pending question is answered with a write at most once, even when the answer is sent twice
CancelledNeverAnswered == ~answeredAfterCancel  \* a question a cancel dropped is never answered afterwards, even by an answer already in flight
TypeOK == /\ access \in {"on", "off", "stale"} /\ conv \in {"live", "gone"} /\ pend \in Kinds
          /\ last \in {"reply", "wrote", "orphan"} /\ phase \in {"idle", "saved", "errored"}
          /\ undo \in {"none", "open", "expired", "used"} /\ ledger \in 0..MaxReqs
          /\ since \in {"same", "answered", "dropped", "other"}
====
