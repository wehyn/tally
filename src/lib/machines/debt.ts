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
