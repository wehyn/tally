// Pure debt rules: status, payments, advances, direction lock, and the status change for settle and reopen.
// The store asks these questions and persists the answers; it must not re-derive them inline.
// Delete is not a status move: deleting a debt removes its row, its history, and unlinks its transactions.

export type DebtStatus = "open" | "settled";
export type DebtDirection = "owed_to_you" | "you_owe";

// A settled debt keeps its last positive amount for display, so status (not amount) is authoritative.
// Callers must have validated 0 < paidMinor <= outstandingMinor; this function does not.
export function debtAfterPayment(outstandingMinor: number, paidMinor: number): { amountMinor: number; status: DebtStatus } {
  const remaining = outstandingMinor - paidMinor;
  return remaining > 0 ? { amountMinor: remaining, status: "open" } : { amountMinor: outstandingMinor, status: "settled" };
}

// A repayment is received on an open debt owed to you, and paid out on an open debt you owe.
export function acceptsPayment(debt: { status: DebtStatus; direction: DebtDirection }, expected: DebtDirection): boolean {
  return debt.status === "open" && debt.direction === expected;
}

// An advance transaction is written only while the debt is open.
export function acceptsAdvance(status: DebtStatus): boolean {
  return status === "open";
}

// Once any transaction links to the debt, its direction stays fixed until the debt is deleted.
export function canChangeDirection(hasLinkedActivity: boolean): boolean {
  return !hasLinkedActivity;
}

// Settle and Reopen set the status and keep the amount. Setting the status a debt already has is a no-op.
export function nextDebtStatus(current: DebtStatus, requested: DebtStatus | undefined): DebtStatus {
  return requested ?? current;
}

export type HistoryAdjustment = { deltaMinor: number; reason: "manual amount edit" | "reopened" };

// The payment history must add up to the amount while a debt is open. A reopened debt gets an adjustment
// to that amount, because its history was not kept while settled. An edit to a settled debt writes nothing.
// Older versions could leave a history negative, and moving that to a large amount can pass the exact integer
// range in one step. The move then goes through zero as two adjustments that are each exact.
export function historyAdjustmentForUpdate(
  before: { status: DebtStatus; amountMinor: number },
  after: { status: DebtStatus; amountMinor: number },
  historyBalanceMinor: number,
): HistoryAdjustment[] {
  const reopened = before.status === "settled" && after.status === "open";
  const edited = before.amountMinor !== after.amountMinor && (before.status === "open" || after.status === "open");
  if (!reopened && !edited) return [];
  const reason = reopened ? "reopened" : "manual amount edit";
  const deltaMinor = after.amountMinor - historyBalanceMinor;
  if (deltaMinor === 0) return [];
  if (!Number.isSafeInteger(deltaMinor)) return [{ deltaMinor: -historyBalanceMinor, reason }, { deltaMinor: after.amountMinor, reason }];
  return [{ deltaMinor, reason }];
}
