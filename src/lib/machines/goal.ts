// Pure rules for a shared goal: its status, membership moves, manager succession, and which
// goal states take contributions or invitation answers. No DB or I/O. The store loads rows,
// asks these functions for the decision, and persists it.

// Goal: active -> completed when contributions meet the target; completed -> active when the
// target is raised or contributions drop below it; archived is terminal (set only by succession).
export type GoalStatus = "active" | "completed" | "archived";

export function nextGoalStatus(current: GoalStatus, raisedMinor: number, targetMinor: number): GoalStatus {
  if (current === "archived") return "archived";
  return raisedMinor >= targetMinor ? "completed" : "active";
}

// Goal membership: the only legal moves. "former" is set by account deletion, never by a user action.
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
