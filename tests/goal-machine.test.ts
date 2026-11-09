import { describe, expect, it } from "vitest";
import { answerInvitation, contributionRefusal, decideSuccession, nextGoalStatus, nextMembershipStatus, type SuccessionMember } from "../src/lib/machines/goal";

describe("goal lifecycle", () => {
  it("completes at the target and reopens when it is raised or contributions drop", () => {
    expect(nextGoalStatus("active", 100, 100)).toBe("completed");
    expect(nextGoalStatus("active", 99, 100)).toBe("active");
    expect(nextGoalStatus("completed", 100, 200)).toBe("active");
  });
  it("treats raised above target as completed", () => {
    expect(nextGoalStatus("completed", 150, 100)).toBe("completed");
    expect(nextGoalStatus("active", 150, 100)).toBe("completed");
  });
  it("never leaves archived", () => {
    expect(nextGoalStatus("archived", 500, 100)).toBe("archived");
    expect(nextGoalStatus("archived", 0, 100)).toBe("archived");
  });
});

describe("goal membership lifecycle", () => {
  it("allows only the documented moves", () => {
    expect(nextMembershipStatus(null, "invite")).toBe("invited");
    expect(nextMembershipStatus("left", "invite")).toBe("invited");
    expect(nextMembershipStatus("removed", "invite")).toBe("invited");
    expect(nextMembershipStatus("invited", "accept")).toBe("accepted");
    expect(nextMembershipStatus("invited", "decline")).toBe("left");
    expect(nextMembershipStatus("accepted", "leave")).toBe("left");
    expect(nextMembershipStatus("accepted", "remove")).toBe("removed");
  });
  it("rejects every other move", () => {
    expect(nextMembershipStatus("accepted", "invite")).toBeNull();
    expect(nextMembershipStatus("invited", "invite")).toBeNull();
    expect(nextMembershipStatus("former", "invite")).toBeNull();
    expect(nextMembershipStatus("left", "accept")).toBeNull();
    expect(nextMembershipStatus("invited", "leave")).toBeNull();
  });
});

describe("goal invitations, contributions and succession", () => {
  it("accepts an invitation only while the goal is live, and declines in any goal status", () => {
    expect(answerInvitation("active", true)).toBe("accepted");
    expect(answerInvitation("completed", true)).toBe("accepted");
    expect(answerInvitation("archived", true)).toBeNull();
    expect(answerInvitation("archived", false)).toBe("left");
  });
  it("takes contributions only while the goal is active", () => {
    expect(contributionRefusal("active")).toBeNull();
    expect(contributionRefusal("completed")).toBe("completed");
    expect(contributionRefusal("archived")).toBe("archived");
  });
  it("hands over to the earliest accepted, enabled member other than the outgoing one", () => {
    const member = (userId: string, acceptedAt: string | null, enabled = true, status: SuccessionMember["status"] = "accepted") =>
      ({ userId, status, acceptedAt, invitedAt: "2026-01-01", enabled });
    expect(decideSuccession("a", [member("a", "2026-01-01"), member("b", "2026-02-01"), member("c", "2026-03-01")])).toEqual({ managerId: "b" });
    expect(decideSuccession("a", [member("a", "2026-01-01"), member("b", "2026-02-01", false), member("c", "2026-03-01")])).toEqual({ managerId: "c" });
    expect(decideSuccession("a", [member("a", "2026-01-01"), member("b", "2026-02-01", true, "invited")])).toEqual({ archive: true });
    expect(decideSuccession("a", [member("a", "2026-01-01")])).toEqual({ archive: true });
  });
});
