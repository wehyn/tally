---------------------------- MODULE Assistant ----------------------------
\* One Ask Tally conversation, as runAssistantPrompt (src/lib/assistant.ts) drives it.
\* A turn has two parts. Before the provider answers, nothing is stored: the turn reads the stored
\* follow-up and waits for the model. After it answers, the user message, the write (if any) and the
\* reply commit in one store transaction (commitTurn). Consent and the chat are checked again at commit.
\* The only interleaving points are the awaited provider call and separate HTTP requests.
\*
\* Legacy = TRUE replays the rules before the fixes (user message stored before the call, no re-check
\* at commit, no replacement of a pending question). findings.cfg runs that variant and must fail.
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxReqs,    \* bound on prompts sent in one run
    Intents,    \* which kinds of user prompt may be sent (subset of AllIntents)
    Env,        \* TRUE: consent revoke/stale and chat delete may interleave with a request
    Clock,      \* TRUE: the ten-second Undo window may expire
    Fails,      \* TRUE: the provider call may fail
    Legacy      \* TRUE: the pre-fix rules (see the header)

AllIntents == {"plain", "uncertainPay", "debtPay", "debtPayNoAmount", "noMatchPay", "amount", "yes"}
\* plain            "Jollibee lunch 250": a complete transaction, no payer named
\* uncertainPay     "maybe Ana paid me?": negated or uncertain payment wording
\* debtPay          "Ana paid me 500" and Ana has one open debt: confirmed repayment
\* debtPayNoAmount  "Ana paid me": payer known, amount missing
\* noMatchPay       "Zed paid me 500", no open debt for Zed
\* amount           an amount-only reply: "500", "P500", "PHP 500", "500 po", "it was 500", "1,000.50"
\* yes              a bare "yes"
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
    \* sticky witnesses, one per rule
    wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain
vars == <<access, conv, pend, last, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs,
          wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>

\* pendingOutcome (src/lib/machines/assistant.ts): a complete prompt that names no open debt and carries
\* its own subject beside the number ("Coffee 120") replaces a pending repayment or income question, and
\* the turn runs with no prior context. An amount-only reply in any common peso form never does.
Outcome(i, p) ==
    IF ~Legacy /\ i = "plain" /\ p \in {"repayment_amount", "repayment_payer", "ordinary_income"}
    THEN "replace" ELSE "answer"
Effective(i, p) == IF Outcome(i, p) = "replace" THEN "none" ELSE p

\* What the code decides for (intent, follow-up the turn answers). Mirrors the override chain at
\* assistant.ts:749-803 and the per-tool branches below it.
Decision(i, p) ==
    CASE i = "plain" ->
            IF p \in {"repayment_amount", "repayment_payer"}
            THEN [out |-> "ask", next |-> p, trap |-> TRUE]           \* assistant.ts:763-770 re-asks
            ELSE IF p = "ordinary_income"
            THEN [out |-> "ask", next |-> p, trap |-> TRUE]           \* assistant.ts:752-757 re-asks
            ELSE [out |-> "wplain", next |-> "none", trap |-> FALSE]
      [] i = "uncertainPay"   -> [out |-> "ask",    next |-> "none",             trap |-> FALSE]  \* :725, :1084
      [] i = "debtPay"        -> [out |-> "wrepay", next |-> "none",             trap |-> FALSE]  \* :784-785, :966
      [] i = "debtPayNoAmount"-> [out |-> "ask",    next |-> "repayment_amount", trap |-> FALSE]  \* :769-770
      [] i = "noMatchPay"     -> [out |-> "ask",    next |-> "ordinary_income",  trap |-> FALSE]  \* :773-774
      [] i = "amount"         ->
            IF p = "repayment_amount"
            THEN [out |-> "wrepay", next |-> "none", trap |-> FALSE]   \* :742-743
            ELSE [out |-> "ask", next |-> "clarification", trap |-> FALSE]
      [] i = "yes"            ->
            IF p = "ordinary_income"
            THEN [out |-> "word", next |-> "none", trap |-> FALSE]     \* :710, :752-757
            ELSE [out |-> "ask", next |-> "clarification", trap |-> FALSE]

\* store.ts deleteTransaction(undoOnly): a debt-linked row never deletes; otherwise only
\* inside the ten-second window.
CodeAllowsUndo(window, kind) == window = "open" /\ kind # "repayment"

\* commitTurn re-checks consent (assertAssistantAccess) and the chat (addMessage) before it writes.
CommitOk == access = "on" /\ conv = "live"

Init ==
    /\ access = "on" /\ conv = "live" /\ pend = "none" /\ last = "reply" /\ phase = "idle"
    /\ intent = "plain" /\ pendAtStart = "none" /\ written = 0 /\ ledger = 0
    /\ undo = "none" /\ txKind = "none" /\ reqs = 0
    /\ wroteNoConsent = FALSE /\ lostFollowup = FALSE /\ trapped = FALSE
    /\ badUndo = FALSE /\ ordNoQuestion = FALSE /\ wroteUncertain = FALSE

\* The route: assertAssistantAccess, then the turn reads the stored follow-up and waits for the model.
Send(i, fresh) ==
    /\ access = "on" /\ conv = "live" /\ reqs < MaxReqs
    /\ intent' = i /\ reqs' = reqs + 1 /\ phase' = "saved"
    /\ written' = IF fresh THEN 0 ELSE written
    /\ IF Legacy
       THEN \* the user message was stored before the call, so the stored follow-up was no longer last
            /\ pendAtStart' = IF last # "orphan" THEN pend ELSE "none"
            /\ pend' = "none" /\ last' = "orphan"
       ELSE /\ pendAtStart' = pend /\ pend' = pend /\ last' = last
    /\ UNCHANGED <<access, conv, ledger, undo, txKind, wroteNoConsent, lostFollowup, trapped,
                   badUndo, ordNoQuestion, wroteUncertain>>

YouSend(i) == i \in Intents /\ phase = "idle" /\ Send(i, TRUE)
YouResend == phase = "errored" /\ Send(intent, FALSE)

\* The provider answered. The user message, the write (if any) and the reply commit together.
\* A refused commit stores nothing. Legacy writes first and then fails at the reply insert.
ProviderOk ==
    /\ phase = "saved"
    /\ IF ~Legacy /\ ~CommitOk
       THEN /\ phase' = "errored"
            /\ UNCHANGED <<access, conv, pend, last, intent, pendAtStart, written, ledger, undo, txKind, reqs,
                           wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>
       ELSE LET d == Decision(intent, Effective(intent, pendAtStart))
                writes == d.out \in {"wplain", "wrepay", "word"}
                replyStored == conv = "live"
            IN /\ ledger' = IF writes THEN ledger + 1 ELSE ledger
               /\ written' = IF writes THEN written + 1 ELSE written
               /\ txKind' = CASE d.out = "wrepay" -> "repayment"
                             [] writes -> "plain"
                             [] OTHER -> txKind
               /\ undo' = CASE d.out = "wrepay" -> "none"      \* recordDebtPayment: undoUntil null
                             [] writes -> IF replyStored THEN "open" ELSE "none"   \* Legacy: the client never got the handle
                             [] OTHER -> undo
               /\ wroteNoConsent' = (wroteNoConsent \/ (writes /\ access # "on"))
               /\ ordNoQuestion'  = (ordNoQuestion \/ (d.out = "word" /\ pendAtStart # "ordinary_income"))
               /\ wroteUncertain' = (wroteUncertain \/ (writes /\ intent = "uncertainPay"))
               /\ trapped' = (trapped \/ d.trap)
               /\ IF replyStored
                  THEN /\ phase' = "idle" /\ last' = (IF writes THEN "wrote" ELSE "reply") /\ pend' = d.next
                  ELSE /\ phase' = "errored" /\ last' = "orphan" /\ pend' = "none"   \* Legacy: the reply insert throws, 404
    /\ UNCHANGED <<access, conv, intent, pendAtStart, reqs, lostFollowup, badUndo>>

ProviderFail ==
    /\ Fails /\ phase = "saved"
    /\ phase' = "errored"
    /\ lostFollowup' = (lostFollowup \/ (IF Legacy THEN pendAtStart # "none" ELSE conv = "live" /\ pend # pendAtStart))
    /\ UNCHANGED <<access, conv, pend, last, intent, pendAtStart, written, ledger, undo, txKind, reqs,
                   wroteNoConsent, trapped, badUndo, ordNoQuestion, wroteUncertain>>

GiveUp == phase = "errored" /\ phase' = "idle" /\ UNCHANGED <<access, conv, pend, last, intent, pendAtStart, written, ledger, undo, txKind, reqs, wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>

NewChat ==
    /\ conv = "gone" /\ phase # "saved"
    /\ conv' = "live" /\ pend' = "none" /\ last' = "reply"
    /\ UNCHANGED <<access, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs, wroteNoConsent,
                   lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>

\* Undo is attempted whenever a transaction exists; the code decides.
YouUndo ==
    /\ undo \in {"open", "expired"} \/ txKind = "repayment"
    /\ IF CodeAllowsUndo(undo, txKind)
       THEN /\ undo' = "used" /\ ledger' = ledger - 1 /\ written' = IF written > 0 THEN written - 1 ELSE 0
            /\ badUndo' = (badUndo \/ undo # "open" \/ txKind = "repayment")   \* deleted outside the window, or a repayment
       ELSE /\ badUndo' = badUndo /\ UNCHANGED <<undo, ledger, written>>   \* the store throws
    /\ UNCHANGED <<access, conv, pend, last, phase, intent, pendAtStart, txKind, reqs, wroteNoConsent,
                   lostFollowup, trapped, ordNoQuestion, wroteUncertain>>

ClockExpires ==
    /\ Clock /\ undo = "open" /\ undo' = "expired"
    /\ UNCHANGED <<access, conv, pend, last, phase, intent, pendAtStart, written, ledger, txKind, reqs,
                   wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>

SetAccess(a) ==
    /\ Env /\ access # a /\ access' = a
    /\ UNCHANGED <<conv, pend, last, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs,
                   wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>

DeleteChat ==
    /\ Env /\ conv = "live" /\ conv' = "gone" /\ pend' = "none"
    /\ UNCHANGED <<access, last, phase, intent, pendAtStart, written, ledger, undo, txKind, reqs,
                   wroteNoConsent, lostFollowup, trapped, badUndo, ordNoQuestion, wroteUncertain>>

\* A finished run: nothing more to send. Keeps TLC from reporting a stuck state as a deadlock.
Done == reqs = MaxReqs /\ phase # "saved" /\ UNCHANGED vars

Next ==
    \/ \E i \in AllIntents : YouSend(i)
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
PlainPromptNotTrapped  == ~trapped           \* an unrelated complete prompt is not swallowed by a pending question
TypeOK == /\ access \in {"on", "off", "stale"} /\ conv \in {"live", "gone"} /\ pend \in Kinds
          /\ last \in {"reply", "wrote", "orphan"} /\ phase \in {"idle", "saved", "errored"}
          /\ undo \in {"none", "open", "expired", "used"} /\ ledger \in 0..MaxReqs
====
