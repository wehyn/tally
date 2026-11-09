// Pure lifecycle rules for records whose status changes over time.
// The store persists these decisions; it should never re-derive them inline.

// Goal: active -> completed when contributions meet the target; completed -> active when the
// target is raised or contributions drop below it; archived is terminal (set only by succession).
export type GoalStatus = "active" | "completed" | "archived";

export function nextGoalStatus(current: GoalStatus, raisedMinor: number, targetMinor: number): GoalStatus {
  if (current === "archived") return "archived";
  return raisedMinor >= targetMinor ? "completed" : "active";
}

// Debt: open -> settled once the outstanding balance reaches zero. A settled record keeps its last
// positive amount for display, so status (not amount) is authoritative.
// Callers must have validated 0 < paidMinor <= outstandingMinor; this function does not.
export type DebtLifecycleStatus = "open" | "settled";

export function debtAfterPayment(outstandingMinor: number, paidMinor: number): { amountMinor: number; status: DebtLifecycleStatus } {
  const remaining = outstandingMinor - paidMinor;
  return remaining > 0 ? { amountMinor: remaining, status: "open" } : { amountMinor: outstandingMinor, status: "settled" };
}

// Goal membership: the only legal moves. "former" is set by account deletion, never by a user action.
// The store routes invite, accept, decline, leave and remove through this table.
export type MembershipStatus = "invited" | "accepted" | "left" | "removed" | "former";
export type MembershipAction = "invite" | "accept" | "decline" | "leave" | "remove";

const MEMBERSHIP_MOVES: Record<MembershipAction, { from: readonly (MembershipStatus | null)[]; to: MembershipStatus }> = {
  invite: { from: [null, "left", "removed"], to: "invited" },
  accept: { from: ["invited"], to: "accepted" },
  decline: { from: ["invited"], to: "left" },
  leave: { from: ["accepted"], to: "left" },
  remove: { from: ["accepted"], to: "removed" },
};

export function nextMembershipStatus(current: MembershipStatus | null, action: MembershipAction): MembershipStatus | null {
  const move = MEMBERSHIP_MOVES[action];
  return move.from.includes(current) ? move.to : null;
}
