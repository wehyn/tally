---
name: verify-assistant
description: Model-check Tally's Ask Tally assistant (consent, follow-up questions, writes, Undo window, conversation delete) with TLA+ and replay the model's assumptions on the real code. Use when a change touches runAssistantPrompt, minimalFollowUpContext, FOLLOWUP_KINDS, getAssistantOptIn/setAssistantConsent, createTransaction's undoUntil, deleteTransaction's undoOnly path, addMessage/deleteConversation, or the assistant and shortcuts/assistant routes.
---

# Verify the assistant

**Property, in one sentence:** the assistant saves a transaction only when the user meant it, once, with consent, and an Undo only works inside its ten seconds and never on a debt repayment.
**Harm if broken:** money records the user did not ask for, duplicated, or recorded after they turned the assistant off.

Model: `model/Assistant.tla`, one conversation. A hand model proves nothing about the code by itself, so `model/conformance.test.ts` replays each fact the model assumes against the real store, route and `runAssistantPrompt`.

## Is your change covered?

| Covered code | What the model says about it |
|---|---|
| `src/lib/assistant.ts` `assertAssistantAccess` (13), `runAssistantPrompt` (666-1087): follow-up reads (701-740), override chain (749-803), the write branches, reply insert (1086) | `Decision` operator, `ProviderOk` |
| `src/lib/provider.ts` `minimalFollowUpContext` (188), `askProvider` failure paths | `Send` (pending question read before the new message), `ProviderFail` |
| `src/lib/assistant-followup.ts` `FOLLOWUP_KINDS` | `Kinds` (only 4 of 17 kinds modeled) |
| `src/lib/store.ts` `createTransaction` undoUntil (825), `deleteTransaction` undoOnly (926), `setAssistantConsent`/`getAssistantOptIn` (1004-1018), `addMessage`, `deleteConversation` (1047-1056) | `CodeAllowsUndo`, `access`, `conv` |
| `src/app/api/assistant/route.ts`, `src/app/api/shortcuts/assistant/route.ts` | `Send` guard (access on, chat live) |

Not covered: bill follow-ups (`bill_*`), debt creation and `debt_transaction`, `account_or_date`, category/date/account inference, finance questions, the widget UI, Shortcut credential auth (see `verify-identity-access`), debt balance rules (see `verify-debts`). Undo is modeled for the latest transaction only. One conversation, one user.

**Sync commit: `c006c65`.** If `git diff c006c65 -- <covered files>` is non-empty, re-read the diff against the model and the conformance tests. Move this commit forward only after you confirm both still describe the code at the new commit.

## Run it

1. Real-code replay (needs `npm ci` once): `.claude/skills/verify-assistant/model/check.sh`. All tests must pass.
2. Model check: give `/statechart` the spec `model/Assistant.tla` once per config and read what it reports.
   - `model/core.cfg`: **must hold** (about 64k states, a few seconds). A violation is a real break of a rule the code upheld at the sync commit.
   - `model/findings.cfg`: **known to fail today** on exactly `NoDuplicateIntentWrite`, `WriteNeedsConsent`, `FollowupSurvivesError`, `PlainPromptNotTrapped`. See below. If one starts to hold, the bug was fixed.
   - `model/flows/*.cfg` with `model/views/*.mjs` redraw the charts in `docs/state-machines/assistant.md`.

## Known findings (current code breaks these)

1. **Duplicate save.** Send "Jollibee lunch 250", delete the chat while the model call is running: the transaction is still saved (`assistant.ts:1077`), the reply insert then fails with 404 (`:1086`), the user sees an error with no Undo, sends it again in a new chat and gets a second transaction. Replayed by the `NoDuplicateIntentWrite` test.
2. **Save after consent withdrawn.** `assertAssistantAccess` runs once, before the model call. Turn the assistant off during the call and the transaction is still saved.
3. **Failed model call drops the question.** The user message is stored before the call (`:684`). If the call fails, the last stored message is the user's, `minimalFollowUpContext` returns nothing, and the next message loses "Ana paid me" and the pending "how much?".
4. **Unrelated prompt is swallowed.** After "How much was repaid?", "Coffee 120" is read as part of the repayment (`repaymentContextText` joins every message since the last finished reply, `:721`) and gets the same question again, nothing saved. Only a bare number or a new chat escapes.

The conformance tests labelled `FINDING` pass while each bug exists and fail when it is fixed. When one fails: confirm the fix, move that invariant from `findings.cfg` to `core.cfg`, and flip the test.

## Telling a real bug from a modeling error

A `core.cfg` counterexample is a sequence of the model's actions (`YouSend`, `ProviderOk`, `YouUndo`, ...). Replay it in `tests/assistant-route.test.ts` style: one provider stub per `ProviderOk`, one `POST` per `YouSend`. If the real code does not reproduce it, the model is wrong: fix the model, never weaken the invariant. If it reproduces, report it with the steps in plain words; do not change product code unless asked.

## Updating after an intended change

New follow-up kind or branch: add it to `Kinds` and `Decision` with the new file:line, add an intent if a new prompt shape reaches it, add a conformance test that drives it, then rerun both checks. Prove the check can still fail: temporarily weaken the real guard in a throwaway worktree (for example drop `Date.now() > Date.parse(row.undo_until)` in `deleteTransaction`, or make `isUncertainStatement` return false) and confirm `check.sh` fails; then change the model guard (for example `CodeAllowsUndo`) and confirm `core.cfg` reports `UndoOnlyInWindow`.
