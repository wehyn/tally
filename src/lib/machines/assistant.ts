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

// A whole message, trimmed, case-folded and stripped of punctuation, so a phrase set matches it exactly.
function normalizedPhrase(prompt: string): string {
  return prompt.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function pendingOutcome(pending: FollowupKind | null, prompt: string): PendingOutcome {
  if (pending === null) return "none";
  return CANCEL_PHRASES.has(normalizedPhrase(prompt)) ? "cancel" : "answer";
}

// The one way to say no to the ordinary income question: a message that, normalized, is exactly one of these. A
// message that only starts with "no" is not a decline, for the reason a cancel is an exact phrase: guessing a refusal
// from free text drops what the user said. A decline only ends the question and never authorizes anything. Any
// other reply that is not a confirmation asks again (ordinaryIncomeTurn), "not now" included: it defers instead of
// refusing, so the user can say cancel.
const INCOME_DECLINE_PHRASES: ReadonlySet<string> = new Set([
  "no", "nope", "nah", "no thanks", "no thank you", "hindi", "ayoko",
]);

export function isOrdinaryIncomeDecline(prompt: string): boolean {
  return INCOME_DECLINE_PHRASES.has(normalizedPhrase(prompt));
}

// A yes to the ordinary income question: the message leads with an affirmative word. It is the one recognizer, the same
// one a plain "yes" to the question passes, and it reads only the message being answered.
const INCOME_CONFIRMATION = /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|record it|record that)\b/i;

export function isIncomeConfirmation(prompt: string): boolean {
  return INCOME_CONFIRMATION.test(prompt);
}

// What one turn does while the ordinary income flow is open (the question is pending, or its account or date
// clarification is). "write": the message is itself a confirmation, so the provider's write may run as income.
// "decline": an exact decline ends the question and writes nothing. "read": a read-only call is answered by the
// ordinary read-only rules and leaves the question pending. "askAgain": anything else writes nothing and asks the
// income question again with the way out. No earlier message can authorize a write. A yes said in an earlier turn, which
// only led to a question about the account or date, is not carried forward, so there is no refusal wording to detect:
// every message that is not a confirmation, however it is worded, fails to write. The user confirms again, and
// "yes, Wallet" does that in one message.
export type OrdinaryIncomeTurn = "write" | "decline" | "read" | "askAgain";

export function ordinaryIncomeTurn(prompt: string, call: TurnCall): OrdinaryIncomeTurn {
  if (isOrdinaryIncomeDecline(prompt)) return "decline";
  if (isIncomeConfirmation(prompt)) return "write";
  return call === "read" ? "read" : "askAgain";
}

// How to confirm after the code asks for the account, date or answer that income the user just said yes to still needs.
// The yes is not carried over, so the next message says it again, with the answer in the same message.
export function incomeConfirmHint(asked: "account_or_date" | "clarification", account?: string): string {
  if (asked === "account_or_date" && account) return `Reply with yes and the account, like "yes, ${account}", or say cancel.`;
  return "Reply with yes and your answer, or say cancel.";
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

// Refusal wording ("Ana did not pay me", "maybe he paid") blocks a write nobody confirmed. The block is one decision
// taken before the turn writes anything, never a reply that replaces one after it: a turn either writes nothing and
// says so, or writes and answers with what it wrote. The decision reads what the call is about to do, after every
// rewrite of it, and whether the refusal was said in earlier turns of the open run (quiet turns included) or in the
// message being answered.
export type TurnCall = "write" | "bill" | "read" | "ask";

// "bill" saves or updates a bill, "write" is any other call that can store money, "read" only reads the ledger,
// and "ask" is every call that stores nothing (a question, or a call the code does not know).
export function turnCallOf(name: string): TurnCall {
  if (name === "create_bill" || name === "update_bill") return "bill";
  if (["log_debt", "log_transaction", "record_debt_payment", "record_debt_repayment"].includes(name)) return "write";
  return name === "finance_question" ? "read" : "ask";
}

// "proceed": no refusal applies, run the call. "askAgain": the call would write after a refusal said in an earlier
// turn; write nothing, say so, and leave the pending question exactly as it was, which cancel can still drop.
// "refuse": write nothing, say nothing was recorded, and end the question. "endQuestion": the refusal is in the
// message being answered and a bill in the same message is its own request, so the bill call runs, the refusal ends
// the pending question, and the reply says what was saved, or that nothing was when the bill still lacked details.
export type RefusalOutcome = "proceed" | "askAgain" | "refuse" | "endQuestion";

export function refusalOutcome(refusal: { earlier: boolean; now: boolean }, pending: FollowupKind | null, call: TurnCall): RefusalOutcome {
  if (!refusal.earlier && !refusal.now) return "proceed";
  if (call === "read") return pending ? "proceed" : "refuse";
  if (call === "ask") return "refuse";
  if (refusal.earlier) return pending ? "askAgain" : "refuse";
  return call === "bill" ? "endQuestion" : "refuse";
}

export const REFUSED_REPLY = "I didn't record anything because I couldn't confirm that the payment happened. If it did, tell me who paid and how much.";
export const DECLINED_REPLY = "Okay, I won't record the money.";
export const REFUSED_AGAIN_REPLY = "You said earlier that this payment didn't happen, so I haven't recorded anything. Say cancel to drop this question.";

// The reply of a turn that ends its pending question because the user refused or declined it. A reply that says
// nothing was recorded is only for a turn that wrote nothing. After a write it keeps the receipt and says the
// question was dropped.
export function endedQuestionReply(reason: "refused" | "declined", answer: string, wrote: boolean): string {
  if (!wrote) return reason === "refused" ? REFUSED_REPLY : DECLINED_REPLY;
  return `${answer}\n${reason === "refused" ? "I also dropped the earlier question about that payment." : "I also dropped the earlier question about recording the money."}`;
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
// The income question asked again from its own account or date clarification is a plain re-ask too, so it carries the hint.
const LINKED_QUESTIONS: ReadonlySet<FollowupKind> = new Set<FollowupKind>(["repayment_amount", "repayment_payer", "ordinary_income"]);

export function cancelHint(pending: FollowupKind | null, asked: FollowupKind | null, modelWorded = false): string | null {
  if (modelWorded || pending === null || asked === null || asked === "clarification" || asked === "debt_transaction") return null;
  if (pending === "account_or_date" && asked === "ordinary_income") return "Or say cancel to drop this.";
  if (pending !== asked && !(LINKED_QUESTIONS.has(pending) && LINKED_QUESTIONS.has(asked))) return null;
  if (asked === "repayment_amount") return "Reply with the amount, or say cancel to drop this.";
  if (asked === "repayment_payer") return "Reply with the person's name, or say cancel to drop this.";
  return "Or say cancel to drop this.";
}
