# Assistant state machines

Subsystem: Ask Tally (`src/lib/assistant.ts`, `src/lib/machines/assistant.ts`, `src/lib/provider.ts`, `src/lib/assistant-followup.ts`, assistant routes, assistant parts of `src/lib/store.ts`). Verified by `.claude/skills/verify-assistant` (sync commit `64efa45`). The charts below were edited by hand to match `model/Assistant.tla` after the fixes, because the `/statechart` renderer is not installed here. Regenerate them with that renderer when it is available (`model/views/*.mjs` and `model/flows/*.cfg`).

## Inventory

### 1. Access (consent), stored in `users.assistant_opt_in` and `assistant_consents.disclosure_hash`

| State | Meaning |
|---|---|
| off | `assistant_opt_in = 0` |
| on | opted in and stored hash equals `providerDisclosureHash()` |
| stale | opted in, but the provider disclosure changed since (hash differs) |

Transitions: `setAssistantConsent(hash)` off/stale to on, `setAssistantConsent(null)` to off (`store.ts`). A disclosure change makes on become stale without any write. The state comes from `getAssistantConsent`, and `canWrite` (`machines/assistant.ts`) is the only rule that lets a write happen. Access is checked once per request by both routes (`api/assistant/route.ts`, `api/shortcuts/assistant/route.ts`, the latter after credential lookup and a 30/min limiter), and again inside the turn's commit transaction before any write (`assertAssistantAccess` in `commitTurn`, fixed in `d05bb50`).

### 2. Request, one POST to runAssistantPrompt

| State | Meaning |
|---|---|
| idle | no request running |
| requesting | model call in flight; nothing is stored yet |
| errored | the model call threw, consent or the chat was gone at commit, or the reply insert threw |

Transitions: send idle to requesting. Requesting to idle when the turn commits: the user message, the write (if any) and the reply are stored in one store transaction (`commitTurn`, `store.transaction`). Requesting to errored when the provider fails or the commit is refused, and then nothing is stored (`d05bb50`, `3f73ccd`). A reply insert that throws rolls the write back too (`c6f5d5b`).

### 3. Pending follow-up, the question the last assistant message waits on

Stored on the assistant message as `followup_kind` (`store.ts`, 17 kinds in `assistant-followup.ts`). Read back only if the **last** stored message is an assistant reply with a kind (`provider.ts:188`). Modeled kinds: none, clarification, ordinary_income, repayment_amount, repayment_payer. The rule for a new prompt is `pendingOutcome` in `machines/assistant.ts`. Its facts come from the existing wording heuristics in `assistant.ts`:

| Pending | New prompt | Outcome |
|---|---|---|
| ordinary_income | "yes" or "no" | answers the question (`:710`, `:752-757`, `:1085`) |
| repayment_amount | a bare number | answers it, saves the repayment (`:742-743`, `:784-785`) |
| repayment_amount, repayment_payer | payment wording, uncertain or negated | answers it through the existing branches; uncertain wording writes nothing and clears the question (`:725`, `:763`, `:1084`) |
| repayment_payer | a name with an open debt | answers it (the payer is matched to the debt) |
| repayment_amount, repayment_payer, ordinary_income | a complete prompt with its own number, naming no open debt | **replaces** the question: the question is dropped, the prompt runs with no prior context, as in a new chat (`25e864f`, `64efa45`) |
| repayment_amount, repayment_payer, ordinary_income | no number (for example "Coffee") | answers it, as before |
| none | payment with no matching open debt | asks ordinary_income (`:773-774`) |
| none | payer known, amount missing | asks repayment_amount (`:769-770`) |

Debt repayment rule from `AGENTS.md`: ask without writing when wording is negated or uncertain, no debt matches, several debt counterparties are named, the model selects a different payer, or the payment exceeds the balance. This table does not change those rules.

### 4. Undo window, per assistant transaction

| State | Meaning |
|---|---|
| open | `undo_until` set 10 s after save (`undoUntilFor`, `createTransaction`) |
| expired | now > `undo_until` (`canUndo`) |
| used | deleted through `DELETE /api/transactions/:id?undo=1` (`api/transactions/[id]/route.ts`) |
| none | debt repayment: `undo_until` null and `debt_id` set; `deleteTransaction` rejects it (`store.ts`) |

### 5. Conversation, live and then deleted (`deleteConversation`, cascades messages). A new chat is created in the same commit as the first turn that succeeds, so a failed first turn leaves no empty chat. The widget also holds UI state (`assistant-widget.tsx`: `busy`, `conversationId`, `openTransactionControl`); not modeled.

## Flow 1: log a transaction, then Undo

TLC: 24 distinct states, `UndoOnlyInWindow` holds. A model call can fail and be retried; an Undo after ten seconds is not an arrow because the store refuses it.

```mermaid
---
title: "Log a transaction, then Undo"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: ready
    lg1: waiting
    lg2: saved
    lg3: error
  }
  class lg0 teal
  class lg1 blue
  class lg2 purple
  class lg3 pink
  s0: Ready
  s1: Waiting for the model: complete transaction
  s2: Error shown
  s3: Saved, Undo open
  s4: Saved, Undo expired
  s5: Saved, then undone
  [*] --> s0
  s0 --> s1: you send a complete transaction
  s1 --> s2: the model call fails
  s1 --> s3: the model answers and Tally saves it
  s2 --> s0: you give up
  s2 --> s1: you send it again
  s3 --> s4: ten seconds pass
  s3 --> s5: you press Undo
  s3 --> s1: you send a complete transaction
  s4 --> s1: you send a complete transaction
  s5 --> s1: you send a complete transaction
  class s0 teal
  class s1 blue
  class s2 pink
  class s3 purple
  class s4 purple
  class s5 purple
```

## Flow 2: follow-up question, answer, save

TLC: 36 distinct states. Every invariant holds. A complete prompt sent while a question is pending no longer returns to the same question: from "Asked: how much was repaid?" it saves as a new request (the `s5 → s3 → s6` path). Repayments leave no Undo (`RepaymentNoUndo` holds). Model-call failures and consent/chat changes are left out of this chart to keep it readable.

```mermaid
---
title: "Follow-up question, then answer"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: ready
    lg1: waiting
    lg2: asking
    lg3: saved
  }
  class lg0 teal
  class lg1 blue
  class lg2 yellow
  class lg3 purple
  s0: Ready
  s1: Waiting for the model: a number
  s2: Waiting for the model: payer, no amount
  s3: Waiting for the model: complete transaction
  s4: Asked a question
  s5: Asked: how much was repaid?
  s6: Saved, Undo open
  s7: Saved, then undone
  s8: Saved, no Undo (repayment)
  [*] --> s0
  s0 --> s1: you send just a number
  s0 --> s2: you say who paid, no amount
  s0 --> s3: you send a complete transaction
  s1 --> s4: the model answers and Tally asks, saving nothing
  s2 --> s5: the model answers and Tally asks, saving nothing
  s3 --> s6: the model answers and Tally saves it
  s4 --> s1: you send just a number
  s4 --> s2: you say who paid, no amount
  s4 --> s3: you send a complete transaction
  s5 --> s1: you send just a number
  s5 --> s2: you say who paid, no amount
  s5 --> s3: you send a complete transaction
  s6 --> s7: you press Undo
  s6 --> s1: you send just a number
  s6 --> s2: you say who paid, no amount
  s6 --> s3: you send a complete transaction
  s7 --> s1: you send just a number
  s7 --> s2: you say who paid, no amount
  s7 --> s3: you send a complete transaction
  s1 --> s8: the model answers and Tally saves it
  class s0 teal
  class s1 blue
  class s2 blue
  class s3 blue
  class s4 yellow
  class s5 yellow
  class s6 purple
  class s7 purple
  class s8 purple
```

## Flow 3: ask without writing

TLC: 26 distinct states. `UncertainNeverWrites` and `OrdinaryIncomeAsked` hold: an uncertain payment returns to Ready with nothing saved, an unmatched payment asks about ordinary income, and income is saved only after that question and a "yes". The "Saved, Undo open" arrow is the confirmed ordinary-income path.

```mermaid
---
title: "Ask without writing"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: ready
    lg1: waiting
    lg2: asking
    lg3: saved
  }
  class lg0 teal
  class lg1 blue
  class lg2 yellow
  class lg3 purple
  s0: Ready
  s1: Waiting for the model: payer with no debt
  s2: Waiting for the model: uncertain payment
  s3: Waiting for the model: a yes
  s4: Asked a question
  s5: Asked: record as ordinary income?
  s6: Saved, Undo open
  s7: Saved, then undone
  [*] --> s0
  s0 --> s1: you report a payment from someone with no open debt
  s0 --> s2: you send an uncertain payment
  s0 --> s3: you send a bare yes
  s1 --> s5: the model answers and Tally asks, saving nothing
  s2 --> s0: the model answers and Tally asks, saving nothing
  s3 --> s4: the model answers and Tally asks, saving nothing
  s4 --> s1: you report a payment from someone with no open debt
  s4 --> s2: you send an uncertain payment
  s4 --> s3: you send a bare yes
  s5 --> s1: you report a payment from someone with no open debt
  s5 --> s2: you send an uncertain payment
  s5 --> s3: you send a bare yes
  s3 --> s6: the model answers and Tally saves it
  s6 --> s7: you press Undo
  class s0 teal
  class s1 blue
  class s2 blue
  class s3 blue
  class s4 yellow
  class s5 yellow
  class s6 purple
  class s7 purple
```

## Findings (all fixed)

Each finding was replayed against the real code before its fix. The conformance replays in `model/conformance.test.ts` (describe block "regressions") now pin the fixed behavior, and `findings.cfg` (`Legacy = TRUE`) still fails on all four invariants, so the checks can fail.

1. **`NoDuplicateIntentWrite`: one request saved twice. Fixed in `c6f5d5b`.** The write and the reply committed separately. A chat deleted during the model call left a transaction with no conversation, and a resend saved a second one. The turn now commits its write and reply in one transaction, so a deleted chat saves nothing and the retry saves once.
2. **`WriteNeedsConsent`: save after consent withdrawn. Fixed in `d05bb50`.** Access was checked only before the model call. It is now checked again at commit, before any write.
3. **`FollowupSurvivesError`: a failed model call forgets the question. Fixed in `3f73ccd`.** The user message used to be stored before the call, so after a failure the pending question was no longer the last message. The user message is now stored with the turn's commit, so a failed call changes nothing.
4. **`PlainPromptNotTrapped`: a pending question swallows an unrelated prompt. Fixed in `25e864f` (repayment amount, ordinary income) and `64efa45` (repayment payer).** "Coffee 120" after "What amount should I use for the repayment?" used to get the same question, because the repayment context joined every message since the last finished reply. A complete prompt with its own number and no open-debt name now replaces the question. A bare answer still resolves it.

## Left out of the model

`bill_*`, `debt_transaction`, `account_or_date` and the other follow-up kinds; category, date and account inference; debt creation; finance questions; the widget UI; Shortcut credential auth; the shortcut route returns only `answer` and `conversationId`, so a Shortcut user never gets a transaction id to Undo with (by design, not modeled). The abandon path for uncertain payment wording (`uncertainRepayment` in `assistant.ts`) is not a machine outcome: its input scans every message of the run, so it stays with the wording heuristics. Hidden steps in the charts: consent changes, chat deletion, retry after an error (flows 2 and 3 only).
