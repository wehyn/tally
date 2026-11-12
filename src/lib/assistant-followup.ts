// What Tally is waiting for from the user after an assistant reply.
// Stored on each assistant message so follow-up handling never has to guess from reply wording.
export const FOLLOWUP_KINDS = [
  "clarification", // a generic question (for example, from the model's ask_clarification tool)
  "ordinary_income", // "should I record this as ordinary income?" (yes or no)
  "debt_transaction", // "say 'add it to Transactions'" after a debt was saved
  "repayment_payer", // which person paid or was paid
  "repayment_amount", // how much the repayment was
  "account_or_date", // a missing or invalid account, or a missing date, for a money movement
  "bill_name",
  "bill_amount",
  "bill_amount_account", // the amount and the account are both needed, so one reply may supply them together
  "bill_start_date",
  "bill_end_date",
  "bill_dates", // the first due date and the exact end date are both needed; one bare date is not enough
  "bill_several", // the amount and both dates are all needed, so one reply may supply them together
  "bill_duplicate", // add another bill or update the existing one
  "bill_schedule", // which of several schedules to update
  "bill_account",
  "bill_details", // any other missing bill detail
] as const;

export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

// Structured facts the code stores on an assistant reply (`followup_data`, JSON), for a decision that must survive the next turns and
// that no wording can carry. `another`: the user chose to add a second debt that repeats one the run already saved, and the question
// this reply asks is still about that second debt, so a duplicate of the first is not a duplicate any more.
export type ReplyData = { another?: true };

// Reads the stored JSON back, ignoring anything that is not the shape written above (an old row, a hand-edited one).
export function parseReplyData(raw: unknown): ReplyData | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { another?: unknown }).another === true ? { another: true } : null;
  } catch {
    return null;
  }
}

export function isFollowupKind(value: unknown): value is FollowupKind {
  return typeof value === "string" && (FOLLOWUP_KINDS as readonly string[]).includes(value);
}

export function isBillFollowup(kind: FollowupKind | null): boolean {
  return kind !== null && kind.startsWith("bill_");
}
