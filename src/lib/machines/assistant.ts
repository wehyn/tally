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
