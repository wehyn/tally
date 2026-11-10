// Pure rules for one Ask Tally conversation turn. assistant.ts and store.ts ask this module for
// each decision and persist the answer; they never re-derive these rules inline.

import { isBillFollowup, type FollowupKind } from "../assistant-followup";

// An assistant-saved transaction can be undone for this long after it is saved.
export const UNDO_WINDOW_MS = 10_000;

export function undoUntilFor(source: "manual" | "assistant", nowMs: number): string | null {
  return source === "assistant" ? new Date(nowMs + UNDO_WINDOW_MS).toISOString() : null;
}

export function canUndo(row: { source: "manual" | "assistant"; undoUntil: string | null }, nowMs: number): boolean {
  return row.source === "assistant" && row.undoUntil !== null && nowMs <= Date.parse(row.undoUntil);
}

// Consent: "on" only while the opt-in matches the current provider disclosure. A disclosure change
// turns "on" into "stale" without any write. Writes need "on" both before and after the model call.
export type ConsentState = "off" | "on" | "stale";

export function canWrite(consent: ConsentState): boolean {
  return consent === "on";
}

// A turn reads the stored question before the model call and stores nothing until it commits, so by then
// another request may have answered or cancelled that question. The turn may commit only while the
// conversation still ends at the message it read (null for a chat with none). A refused turn stores nothing.
export function turnMayCommit(readLastMessageId: string | null, currentLastMessageId: string | null): boolean {
  return readLastMessageId === currentLastMessageId;
}

// Pending follow-up: what a new prompt does to the question the last reply asked. The only way to drop
// a question is to say so: a prompt that, trimmed, case-folded and stripped of punctuation, equals one of
// these phrases. Everything else is an "answer", which keeps the pending context and leaves the reply to the
// existing handling, and that asks again and writes nothing when the reply is not a usable answer. Guessing
// from free text that a reply is a new request was abandoned: a wrong guess drops the context and the guards
// that read it and writes money to the wrong place, while a wrong "answer" only asks again. "no" is not here:
// it already answers a yes or no question.
export type PendingOutcome = "none" | "answer" | "cancel";

const CANCEL_PHRASES: ReadonlySet<string> = new Set([
  "cancel", "never mind", "nevermind", "skip", "forget it", "stop", "ayoko na", "wag na", "huwag na", "di na",
]);

export function pendingOutcome(pending: FollowupKind | null, prompt: string): PendingOutcome {
  if (pending === null) return "none";
  const phrase = prompt.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return CANCEL_PHRASES.has(phrase) ? "cancel" : "answer";
}

// What a turn that asked no question did. "read" only read the ledger (the debt list, a finance answer),
// "billSaved" saved or updated a bill, and "other" is everything else, such as a completed write.
export type QuietTurn = "read" | "billSaved" | "other";

// The pending question a turn stores with its reply. A turn that asks a question of its own replaces the
// pending one. A turn that only reads is not an answer to the pending question and not a cancel of it, so the
// question stays exactly as it was and the next reply still answers it. A saved bill is an answer to a bill
// question, which it ends, and not to any other, which stays. Every other turn that asks nothing ends it.
export function followupAfterTurn(pending: FollowupKind | null, asked: FollowupKind | null, turn: QuietTurn): FollowupKind | null {
  if (asked) return asked;
  if (turn === "read") return pending;
  if (turn === "billSaved") return isBillFollowup(pending) ? null : pending;
  return null;
}

// How many messages of an open follow-up run reach the model and the local reading of the run.
export const OPEN_RUN_LIMIT = 12;

// The run's first message is the statement the pending question is about ("Ana paid me"). Trimming it away
// turns a later bare "500" into an ordinary expense, so a longer run keeps it and drops the oldest of the rest.
export function capOpenRun<T>(run: readonly T[], limit = OPEN_RUN_LIMIT): T[] {
  return run.length <= limit ? [...run] : [run[0], ...run.slice(run.length - (limit - 1))];
}

// What a cancel tells the user about what happened to the dropped question. Most questions are asked before
// anything is saved, so nothing was recorded. The offer to add a just-saved debt to Transactions is different,
// because the debt is already in Debts, and so is every question that continues it ("add it to Transactions"
// asking for an account or a date). Saying nothing was recorded there would invite entering the debt again.
// No bill question is asked after a bill was saved, so none needs a wording of its own.
export function cancelReply(pending: FollowupKind, debtAlreadySaved: boolean): string {
  return pending === "debt_transaction" || debtAlreadySaved
    ? "Okay, I dropped that question. The debt stays in Debts, and nothing was added to Transactions."
    : "Okay, I dropped that question. Nothing was recorded.";
}

// Whether a reply of the open question run already saved a debt. The run is the messages since the last reply
// that asked nothing, and the saving reply is the one that carries the debt.
export function runSavedDebt(messages: readonly { role: "user" | "assistant"; followup?: FollowupKind | null; debtId?: string | null }[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant" && !messages[index].followup) return false;
    if (messages[index].debtId) return true;
  }
  return false;
}

// The way out, appended when the code asks a question again while one is pending. The repayment and income
// questions the code forces on the user lead to each other, so any of them asked right after any of them
// carries it. Every other kind carries it only when the same question repeats. A first ask has none, and
// neither does a question the model worded itself, whatever kind it is stored under (during a repayment with
// no amount yet the model's own question is stored as the amount question), or the offer to add a debt to
// Transactions. The hint names what to reply to the code's own question, so it would be wrong under another.
const LINKED_QUESTIONS: ReadonlySet<FollowupKind> = new Set<FollowupKind>(["repayment_amount", "repayment_payer", "ordinary_income"]);

export function cancelHint(pending: FollowupKind | null, asked: FollowupKind | null, modelWorded = false): string | null {
  if (modelWorded || pending === null || asked === null || asked === "clarification" || asked === "debt_transaction") return null;
  if (pending !== asked && !(LINKED_QUESTIONS.has(pending) && LINKED_QUESTIONS.has(asked))) return null;
  if (asked === "repayment_amount") return "Reply with the amount, or say cancel to drop this.";
  if (asked === "repayment_payer") return "Reply with the person's name, or say cancel to drop this.";
  return "Or say cancel to drop this.";
}
