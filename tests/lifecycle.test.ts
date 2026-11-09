import { describe, expect, it } from "vitest";
import { nextGoalStatus, nextMembershipStatus } from "../src/lib/lifecycle";

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
