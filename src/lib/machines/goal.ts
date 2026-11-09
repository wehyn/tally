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

// Invitations: an archived goal takes no new accepted member, so its invitations cannot be accepted.
// Declining still records the answer ("left") and adds no member.
export function answerInvitation(goal: GoalStatus, accept: boolean): MembershipStatus | null {
  if (accept && goal === "archived") return null;
  return nextMembershipStatus("invited", accept ? "accept" : "decline");
}

// Contributions: only an active goal takes them. The refusal names why, for the caller's message.
export type ContributionRefusal = "completed" | "archived";

export function contributionRefusal(goal: GoalStatus): ContributionRefusal | null {
  if (goal === "active") return null;
  return goal;
}

// Succession: when the manager leaves or is disabled, the earliest accepted, enabled member other
// than the outgoing one takes over. No such member means the goal archives. The store also closes
// every accepted membership on archive, so an archived goal has no accepted member.
export type SuccessionMember = {
  userId: string;
  status: MembershipStatus;
  acceptedAt: string | null;
  invitedAt: string;
  enabled: boolean;
};
export type Succession = { managerId: string } | { archive: true };

export function decideSuccession(outgoingUserId: string, members: readonly SuccessionMember[]): Succession {
  const successor = members
    .filter((member) => member.status === "accepted" && member.enabled && member.userId !== outgoingUserId)
    .sort((a, b) => compareNullableAsc(a.acceptedAt, b.acceptedAt) || compareNullableAsc(a.invitedAt, b.invitedAt))[0];
  return successor ? { managerId: successor.userId } : { archive: true };
}

function compareNullableAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
