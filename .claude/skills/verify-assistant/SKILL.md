---
name: verify-assistant
description: Model-check Tally's Ask Tally assistant (consent, follow-up questions, writes, Undo window, conversation delete) with TLA+ and replay the model's assumptions on the real code. Use when a change touches runAssistantPrompt, minimalFollowUpContext, FOLLOWUP_KINDS, getAssistantOptIn/setAssistantConsent, createTransaction's undoUntil, deleteTransaction's undoOnly path, addMessage/deleteConversation, src/lib/machines/assistant.ts, or the assistant and shortcuts/assistant routes.
---

# Verify the assistant

**Property, in one sentence:** the assistant saves a transaction only when the user meant it, once, with consent, and an Undo only works inside its ten seconds and never on a debt repayment.
**Harm if broken:** money records the user did not ask for, duplicated, or recorded after they turned the assistant off.

Model: `model/Assistant.tla`, one conversation. A hand model proves nothing about the code by itself, so `model/conformance.test.ts` replays each fact the model assumes against the real store, route and `runAssistantPrompt`.

## Is your change covered?

| Covered code | What the model says about it |
|---|---|
| `src/lib/assistant.ts` `assertAssistantAccess` (13), `runAssistantPrompt` and `commitTurn`: the turn's reads, the commit transaction, the override chain, the write branches, the reply insert | `Decision`, `Effective`, `CommitOk`, `ProviderOk` |
| `src/lib/machines/assistant.ts`: `canWrite` (consent), `pendingOutcome` (replace or answer, from the facts `promptFacts` builds in `assistant.ts`), `undoUntilFor` and `canUndo` (Undo window) | `CommitOk`, `Outcome`, `CodeAllowsUndo` |
| `src/lib/provider.ts` `minimalFollowUpContext` (188, including the `context_start` boundary), `askProvider` failure paths | `Send` (the stored follow-up is the context), `ProviderFail` |
| `src/lib/assistant-followup.ts` `FOLLOWUP_KINDS` | `Kinds` (`none` and the four question kinds only) |
| `src/lib/store.ts` `transaction`, `createTransaction` and `deleteTransaction` (Undo), `getAssistantConsent`/`getAssistantOptIn`, `addMessage`, `deleteConversation` | `CodeAllowsUndo`, `access`, `conv` |
| `src/app/api/assistant/route.ts`, `src/app/api/shortcuts/assistant/route.ts` | `Send` guard (access on, chat live) |

Not covered: bill follow-ups (`bill_*`), debt creation and `debt_transaction`, `account_or_date`, category/date/account inference, finance questions, the widget UI, Shortcut credential auth (see `verify-identity-access`), debt balance rules (see `verify-debts`). Undo is modeled for the latest transaction only. One conversation, one user. The uncertain-wording abandon path (`uncertainRepayment` in `assistant.ts`) is not in the machine; the model covers its effect (`UncertainNeverWrites`) only.

**Sync commit: `f6ee8eb`.** If `git diff f6ee8eb -- <covered files>` is non-empty, re-read the diff against the model and the conformance tests. Move this commit forward only after you confirm both still describe the code at the new commit.

## Run it

1. Real-code replay (needs `npm ci` once): `.claude/skills/verify-assistant/model/check.sh`. All 16 tests must pass.
2. Model check. Use `/statechart` on `model/Assistant.tla` once per config, or run TLC directly with a `tla2tools.jar` (for example `java -cp tla2tools.jar tlc2.TLC -workers 4 -config model/core.cfg model/Assistant.tla` from `.claude/skills/verify-assistant`).
   - `model/core.cfg`: **must hold** (about 20k distinct states, a few seconds). A violation is a real break of a rule the code upholds at the sync commit.
   - `model/findings.cfg`: sets `Legacy = TRUE`, which replays the rules before the fixes. It **must fail** on the four invariants (`NoDuplicateIntentWrite`, `WriteNeedsConsent`, `FollowupSurvivesError`, `PlainPromptNotTrapped`). TLC reports the first one it reaches; to check a single invariant, put only that name on the `INVARIANTS` line.
   - `model/doubt.cfg`: sets `Doubt = TRUE`, which replays the first replacement rule (`232f564`: any word beyond amount filler replaces a pending question). It **must fail** on `AnswerNotReplaced`.
   - `model/flows/*.cfg` with `model/views/*.mjs` redraw the charts in `docs/state-machines/assistant.md`. The renderer is not installed everywhere, so check the doc's charts by hand against the model when it is not.

## Fixed findings (kept as regression replays)

Each finding is fixed and pinned by a replay in `model/conformance.test.ts` (describe block "regressions") and a route test in `tests/assistant-route.test.ts` ("assistant turn commit").

1. **Duplicate save** (`c6f5d5b`). The write and its reply used to commit separately. Now `commitTurn` runs them in one store transaction. A deleted chat makes the reply insert throw, which rolls the write back. Replayed by `NoDuplicateIntentWrite (fixed)`.
2. **Save after consent withdrawn** (`d05bb50`). Access is checked again inside the commit transaction, before any write. The check lives in `commitTurn` itself, which every stored turn uses, so the local debt-list answer (no model call) is covered too; `tests/assistant-route.test.ts` pins that path ("refuses a local debt-list turn when consent is withdrawn while the request body streams"). Replayed by `WriteNeedsConsent (fixed)`.
3. **Failed model call drops the question** (`3f73ccd`). The user message is stored with the turn's commit, not before the call. A failed call stores nothing, so the pending question stays last. Replayed by `FollowupSurvivesError (fixed)`. The message is stamped with the time the request was received (`receivedAt`, taken at the start of `runAssistantPrompt` and passed through `commitTurn` to `addMessage`), not the commit time, because a later follow-up reads relative dates ("today") from it: "lunch today" sent at 23:59:59 and answered "250" after midnight still saves on the first day. `addMessage` never stamps a message before the latest one in its conversation, and `getConversation` breaks ties by insertion order, so a reply never sorts ahead of its prompt. Pinned by route tests in `tests/assistant-route.test.ts` ("keeps today relative to when the request arrived ...") and `tests/store.test.ts`; the model has no dates, so there is no invariant.
4. **Unrelated prompt is swallowed** (`25e864f` for a pending repayment amount or ordinary income question; `64efa45` for a pending repayment payer question). `pendingOutcome` in `src/lib/machines/assistant.ts` decides. A complete prompt that carries its own subject word beside a number ("Coffee 120"), names no open debt and does not hedge replaces the question, and the prompt runs with no prior context. Replacement needs that positive signal. Everything else answers, because a wrong replace drops the pending context and with it the guards that read it (uncertain wording asks first, a repayment is matched to the payer's open debt). The facts come from `promptFacts` in `src/lib/assistant.ts`: the subject test removes amounts (digits, separators, peso markers, `k` and `m` shorthand), dates, the user's own account names, answer filler (`po`, `daw`, `bucks`, `cash`, ...) and hedges, and any hedge or negation ("maybe 500", "not 500", "500?") is a fact of its own. So an amount-only reply in any common peso form ("500", "P500", "PHP 500", "500 po", "it was 500"), an amount with a detail ("500 cash", "500 to Wallet", "500 sa GCash", "500 yesterday", "5k", "500 daw", "500 bucks"), a hedged or negated reply, a yes or no, debt-payment wording, or a name with an open debt all answer the question. A detailed amount reply to a pending repayment amount is read as the amount (`answeredAmountFromPrompt`) and an account it names is the repayment's account. The replacement is persisted: the replacing user message is stored with `context_start = 1` and `minimalFollowUpContext` never reads past it, so the next turn of the new request ("Wallet" after "Which account?") cannot reload the abandoned question. Replayed by `PlainPromptNotTrapped (fixed)`, `PlainPromptNotTrapped (payer)`, `PlainPromptNotTrapped (amount forms)`, `PlainPromptNotTrapped (stays replaced)`, `AnswerNotReplaced (hedged)` and `AnswerNotReplaced (detail)`; the wording tables are in `tests/assistant-machine.test.ts` and the flows in `tests/assistant-route.test.ts`. The first replacement rule (`232f564`) replaced on any word beyond filler, so "maybe 500" saved a 500 expense and "500 cash" falsely offered ordinary income while Ana's debt stayed; `doubt.cfg` keeps that rule checkable.

## Telling a real bug from a modeling error

A `core.cfg` counterexample is a sequence of the model's actions (`YouSend`, `ProviderOk`, `YouUndo`, ...). Replay it in `tests/assistant-route.test.ts` style: one provider stub per `ProviderOk`, one `POST` per `YouSend`. If the real code does not reproduce it, the model is wrong: fix the model, never weaken the invariant. If it reproduces, report it with the steps in plain words; do not change product code unless asked.

## Updating after an intended change

New follow-up kind or branch: add it to `Kinds` and `Decision` with the new file:line, add an intent if a new prompt shape reaches it, add a conformance test that drives it, then rerun both checks.

Prove the check can still fail. `findings.cfg` does this for the four rules (`Legacy = TRUE`) and `doubt.cfg` for `AnswerNotReplaced` (`Doubt = TRUE`). For a single rule, copy the model to a scratch directory and weaken one guard. For example `CommitOk == conv = "live"` drops the consent re-check, and `WriteNeedsConsent` must fail. Or make `ProviderFail` clear `pend`, and `FollowupSurvivesError` must fail. Then confirm `core.cfg` holds again on the real model.
