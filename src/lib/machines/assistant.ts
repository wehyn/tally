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

// The longest open follow-up run, in messages, that a turn may extend. The whole run reaches the model and the
// local reading of it, and no message is ever left out, because choosing which ones to keep was a guess that
// kept dropping the statement or the correction a later answer depends on. A run that reaches the limit ends
// its question instead.
export const MAX_OPEN_RUN_MESSAGES = 24;

// A turn that would extend a run already at the limit ends the question. It calls no model and writes nothing.
// An exact cancel still gets its own reply, and with nothing pending there is no run.
export function runExpired(runLength: number, outcome: PendingOutcome): boolean {
  return outcome === "answer" && runLength >= MAX_OPEN_RUN_MESSAGES;
}

// A message of the open run, as stored. readOnly marks a reply that only read the ledger.
export type RunMessage = { role: "user" | "assistant"; followup?: FollowupKind | null; billId?: string | null; readOnly?: boolean };

// A reply is quiet when it handled its own request and left the pending question pending: a bill saved without
// a question (the reply carries the bill) or a read-only answer. The user message it answered says nothing about
// the pending question.
export function isQuietReply(reply: RunMessage): boolean {
  return reply.role === "assistant" && !!reply.followup && (!!reply.billId || !!reply.readOnly);
}

// What the code reads from the user's words, and which messages of the open run it may read.
// A hint overrides a field the model chose (account, date, time, category, amount, payer, bill details, the debt
// the user named, an opt-in) and so decides where money goes. It reads only the messages that belong to the
// pending question, or a bill or a finance question answered in between would move a repayment.
// A guard can only refuse or ask (uncertain or negated wording, a declined transaction), and it reads the whole
// open run, because a refusal said anywhere in the run must still block a write nobody confirmed afterwards.
export type UserTextUse = "hint" | "guard";

// The user messages of the open run that belong to the pending question: the statement that started it and the
// answers, re-asks and corrections addressed to it. The model still gets the whole run, since it can tell a
// handled turn from the question by its reply.
export function ownUserMessages<T extends RunMessage>(run: readonly T[]): T[] {
  return run.filter((message, index) => message.role === "user" && !(index + 1 < run.length && isQuietReply(run[index + 1])));
}

// Every user message of the open run, quiet turns included.
export function guardUserMessages<T extends RunMessage>(run: readonly T[]): T[] {
  return run.filter((message) => message.role === "user");
}

export function userMessagesFor<T extends RunMessage>(use: UserTextUse, run: readonly T[]): T[] {
  return use === "hint" ? ownUserMessages(run) : guardUserMessages(run);
}

// What the open question run already saved. A debt is in Debts and a bill is in Bills, so a reply that drops the
// question must not say nothing was recorded when either exists.
export type RunSaved = { debt: boolean; bill: boolean };

// What a dropped question says it left behind. Most questions are asked before anything is saved, so nothing was
// recorded. The offer to add a just-saved debt to Transactions is different, because the debt is already in Debts,
// and so is every question that continues it ("add it to Transactions" asking for an account or a date). Saying
// nothing was recorded there would invite entering the debt again. A bill saved under a question that is not about
// a bill leaves that question pending, and the bill may have posted its due-today expense, so the wording about
// Transactions is only made for a debt alone.
function whatStays(pending: FollowupKind | null, saved: RunSaved): string | null {
  const debt = saved.debt || pending === "debt_transaction";
  if (debt && saved.bill) return "The debt stays in Debts and the bill stays in Bills.";
  if (debt) return "The debt stays in Debts, and nothing was added to Transactions.";
  if (saved.bill) return "The bill stays in Bills, and nothing else was recorded.";
  return null;
}

// What an expired question tells the user.
export function expiredReply(saved: RunSaved): string {
  const stays = whatStays(null, saved);
  return stays
    ? `That question has been open too long, so I dropped it. ${stays}`
    : "That question has been open too long, so I dropped it. Nothing was recorded. Please send the details again.";
}

// What a cancel tells the user about what happened to the dropped question.
export function cancelReply(pending: FollowupKind, saved: RunSaved): string {
  return `Okay, I dropped that question. ${whatStays(pending, saved) ?? "Nothing was recorded."}`;
}

// What a reply of the open question run already saved. The run is the messages since the last reply that asked
// nothing, and the saving reply is the one that carries the debt or the bill.
export function runSaved(messages: readonly { role: "user" | "assistant"; followup?: FollowupKind | null; debtId?: string | null; billId?: string | null }[]): RunSaved {
  const saved = { debt: false, bill: false };
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant" && !messages[index].followup) break;
    if (messages[index].debtId) saved.debt = true;
    if (messages[index].billId) saved.bill = true;
  }
  return saved;
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
