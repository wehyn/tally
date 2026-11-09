// Pure lifecycle rules for debts. The store persists these decisions; it should never re-derive them inline.
// Goal rules live in ./machines/goal.

// Debt: open -> settled once the outstanding balance reaches zero. A settled record keeps its last
// positive amount for display, so status (not amount) is authoritative.
// Callers must have validated 0 < paidMinor <= outstandingMinor; this function does not.
export type DebtLifecycleStatus = "open" | "settled";

export function debtAfterPayment(outstandingMinor: number, paidMinor: number): { amountMinor: number; status: DebtLifecycleStatus } {
  const remaining = outstandingMinor - paidMinor;
  return remaining > 0 ? { amountMinor: remaining, status: "open" } : { amountMinor: outstandingMinor, status: "settled" };
}
