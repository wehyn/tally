// Pure rules for one recurring bill's schedule. The store persists what these decide and must not
// re-derive them inline. Dates are YYYY-MM-DD strings, compared as strings.
import { advanceBillDate, type BillFrequency } from "../dates";

// Read off the stored row: a bill is archived (user or end date), due, or not yet due.
export type BillScheduleState = "not-yet-due" | "due" | "archived";

// What one posting attempt does. A failed attempt rolls back and keeps the due date.
export type BillPostingOutcome = "posted-and-advanced" | "ended" | "failed-keeps-date";

export type BillSchedule = {
  nextDueDate: string;
  endDate: string | null;
  archived: boolean;
  frequency: BillFrequency;
  anchorDay: number;
  anchorMonth: number;
};

export function billScheduleState(bill: Pick<BillSchedule, "nextDueDate" | "archived">, today: string): BillScheduleState {
  if (bill.archived) return "archived";
  return bill.nextDueDate <= today ? "due" : "not-yet-due";
}

export type PostingPlan =
  | { kind: "none" }
  | { kind: "end" }
  | { kind: "post"; dueDate: string; nextDueDate: string; outcome: "posted-and-advanced" | "ended" };

// Only a due, active bill posts. A due date already past the end date archives the bill without a post.
export function planPosting(bill: BillSchedule, today: string): PostingPlan {
  if (billScheduleState(bill, today) !== "due") return { kind: "none" };
  if (bill.endDate !== null && bill.nextDueDate > bill.endDate) return { kind: "end" };
  const nextDueDate = advanceBillDate(bill.nextDueDate, bill.frequency, bill.anchorDay, bill.anchorMonth);
  const ends = bill.endDate !== null && nextDueDate > bill.endDate;
  return { kind: "post", dueDate: bill.nextDueDate, nextDueDate, outcome: ends ? "ended" : "posted-and-advanced" };
}

// A posted due date is history. Moving the schedule to it or before it would post it again.
export function canScheduleDueDate(lastPostedDueDate: string | null, nextDueDate: string): boolean {
  return lastPostedDueDate === null || nextDueDate > lastPostedDueDate;
}
