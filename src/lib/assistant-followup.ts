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
// this reply asks is still about that second debt, so a duplicate of the first is not a duplicate any more. `duplicateCall`: the
// debt write the duplicate question asked about (its note, due date, purpose, account and the rest), so "another" adds that debt and
// not a bare one rebuilt from the saved debt.
// `asks`: WHAT the question this reply asks is waiting for, so the answer is judged by that question's vocabulary and not by one
// list for every question (a category name, a short description, an account, a date, an amount, or the choice a duplicate, an
// ambiguity or a separate entry offers). A row without it is read as before.
export const ASKS = ["category", "description", "account", "date", "amount", "duplicate", "ambiguity", "separate"] as const;
export type Asks = (typeof ASKS)[number];
export type ReplyData = { another?: true; duplicateCall?: Record<string, string | number | boolean>; asks?: Asks; separate?: SeparateHold };

// The statement a message in an open debt flow made that the code did not write, because it was not an answer to the flow's question.
// The reply asks once whether to record it as a separate new entry and keeps what it needs to do so: the call the model made, the words
// the user said and when, and the question it replaced (`resume`, so "that debt" asks that question again exactly as it was).
export type SeparateHold = {
  name: string;
  args: Record<string, unknown>;
  statement: string;
  at: string;
  resume?: { kind: FollowupKind; text: string; data?: ReplyData };
};

// The data of a question without its separate-entry hold, which is what "that debt" restores.
export function withoutSeparate(data: ReplyData | null | undefined): ReplyData | undefined {
  if (!data) return undefined;
  const kept: ReplyData = {};
  if (data.another) kept.another = true;
  if (data.duplicateCall) kept.duplicateCall = data.duplicateCall;
  if (data.asks) kept.asks = data.asks;
  return kept.another || kept.duplicateCall || kept.asks ? kept : undefined;
}

export function isAsks(value: unknown): value is Asks {
  return typeof value === "string" && (ASKS as readonly string[]).includes(value);
}

const DUPLICATE_CALL_KEYS = ["direction", "counterparty", "amount", "note", "dueDate", "description", "category", "account", "date", "time", "recordTransaction"] as const;

// The part of a debt write worth keeping on a reply: the known keys with plain values, each string cut to a sane length.
export function duplicateCallData(args: Record<string, unknown>): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  for (const key of DUPLICATE_CALL_KEYS) {
    const value = args[key];
    if (typeof value === "string") kept[key] = value.slice(0, 600);
    else if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
    else if (typeof value === "boolean") kept[key] = value;
  }
  return kept;
}

// A model call's arguments as plain JSON the store can keep: strings cut, numbers finite, nesting and size bounded.
function plainValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.slice(0, 600);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (depth > 0 && Array.isArray(value)) return value.slice(0, 50).map((item) => plainValue(item, depth - 1)).filter((item) => item !== undefined);
  if (depth > 0 && value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const plain = plainValue(item, depth - 1);
      if (plain !== undefined) out[key] = plain;
    }
    return out;
  }
  return undefined;
}
export function plainArgs(args: Record<string, unknown>): Record<string, unknown> {
  return plainValue(args, 3) as Record<string, unknown>;
}

function readSeparate(raw: unknown): SeparateHold | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const hold = raw as { name?: unknown; args?: unknown; statement?: unknown; at?: unknown; resume?: unknown };
  if (typeof hold.name !== "string" || !hold.name || hold.name.length > 60 || typeof hold.statement !== "string" || typeof hold.at !== "string") return undefined;
  if (!hold.args || typeof hold.args !== "object" || Array.isArray(hold.args)) return undefined;
  const result: SeparateHold = { name: hold.name, args: plainArgs(hold.args as Record<string, unknown>), statement: hold.statement.slice(0, 2000), at: hold.at.slice(0, 40) };
  const resume = hold.resume as { kind?: unknown; text?: unknown; data?: unknown } | undefined;
  if (resume && typeof resume === "object" && isFollowupKind(resume.kind) && typeof resume.text === "string") {
    result.resume = { kind: resume.kind, text: resume.text.slice(0, 2000) };
    const data = readReplyData(resume.data, false);
    if (data) result.resume.data = data;
  }
  return result;
}

function readReplyData(parsed: unknown, allowSeparate: boolean): ReplyData | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data: ReplyData = {};
  if ((parsed as { another?: unknown }).another === true) data.another = true;
  const call = (parsed as { duplicateCall?: unknown }).duplicateCall;
  if (call && typeof call === "object" && !Array.isArray(call)) data.duplicateCall = duplicateCallData(call as Record<string, unknown>);
  const asks = (parsed as { asks?: unknown }).asks;
  if (isAsks(asks)) data.asks = asks;
  const separate = allowSeparate ? readSeparate((parsed as { separate?: unknown }).separate) : undefined;
  if (separate) data.separate = separate;
  return data.another || data.duplicateCall || data.asks || data.separate ? data : null;
}

// Reads the stored JSON back, ignoring anything that is not the shape written above (an old row, a hand-edited one).
export function parseReplyData(raw: unknown): ReplyData | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return readReplyData(JSON.parse(raw), true);
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
