// Pure rules for one Ask Tally conversation turn. assistant.ts and store.ts ask this module for
// each decision and persist the answer; they never re-derive these rules inline.

import type { FollowupKind } from "../assistant-followup";

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

// Pending follow-up: what a new prompt does to the question the last reply asked. "answer" resolves
// it, or leaves it to the existing answer handling. "replace" means the prompt is a complete request
// of its own, so the question is dropped and the prompt is handled as if it began a new chat.
// A wrong "answer" only re-asks the question and writes nothing, while a wrong "replace" throws the
// user's context away, so every doubt resolves to "answer".
export type PendingOutcome = "none" | "answer" | "replace";

export type PromptFacts = {
  yesOrNo: boolean; // starts with yes or no
  paymentWording: boolean; // incoming or outgoing debt repayment wording
  hasNumber: boolean; // carries a number
  ownSubject: boolean; // has a word beyond the amount, its peso marker and answer filler ("Coffee 120", not "P500" or "it was 500")
  namesOpenDebt: boolean; // names a person with an open debt, which answers a payer question
};

const REPLACEABLE_QUESTIONS: ReadonlySet<FollowupKind> = new Set<FollowupKind>(["repayment_amount", "repayment_payer", "ordinary_income"]);

export function pendingOutcome(pending: FollowupKind | null, prompt: PromptFacts): PendingOutcome {
  if (pending === null) return "none";
  if (!REPLACEABLE_QUESTIONS.has(pending)) return "answer";
  if (prompt.yesOrNo || prompt.paymentWording || prompt.namesOpenDebt) return "answer";
  return prompt.hasNumber && prompt.ownSubject ? "replace" : "answer";
}
