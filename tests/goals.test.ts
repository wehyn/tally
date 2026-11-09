import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/lib/store";

let store: ReturnType<typeof createStore>;
beforeEach(() => { store = createStore(new Database(":memory:")); store.migrate(); });

const admin = () => store.registerUser("goal_admin", "hash");

describe("goal rules that hold", () => {
  it("manager leaving hands the goal to the earliest enabled accepted member", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash");
    const g = store.createGoal(a.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(a.id, g, "goal_b");
    store.respondInvitation(b.id, (store.listInvitations(b.id)[0] as { id: string }).id, true);
    store.changeMembership(a.id, g, a.id, "leave");
    expect(store.listGoals(b.id)[0].managerId).toBe(b.id);
  });
  it("the last manager leaving archives the goal", () => {
    const a = admin(); const g = store.createGoal(a.id, { name: "Trip", targetMinor: 1000 });
    store.changeMembership(a.id, g, a.id, "leave");
    expect(store.listGoals(a.id)).toHaveLength(0);
  });
  it("a completed goal rejects contributions until the target is raised", () => {
    const a = admin(); const g = store.createGoal(a.id, { name: "Trip", targetMinor: 1000 });
    store.addContribution(a.id, g, { amountMinor: 1000, date: "2026-10-09" });
    expect(() => store.addContribution(a.id, g, { amountMinor: 1, date: "2026-10-09" })).toThrow(/complete/);
  });
});

describe("goal rules fixed from the TLA+ findings (Goals.tla)", () => {
  // ArchivedGoalHasNoAcceptedMember: an invitation outlives the archive.
  it("a pending invitation cannot be accepted after the goal is archived", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash");
    const g = store.createGoal(a.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(a.id, g, "goal_b");
    const membershipId = (store.listInvitations(b.id)[0] as { id: string }).id;
    store.changeMembership(a.id, g, a.id, "leave"); // nobody accepted: goal archived
    expect(() => store.respondInvitation(b.id, membershipId, true)).toThrow(/archived/);
    expect(store.listGoals(b.id)).toHaveLength(0);
  });
  // ManagerIsEnabled: disabling a manager runs the same succession as leaving.
  it("a disabled manager does not stay manager of a live goal", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(b.id, g, "goal_c");
    store.respondInvitation(c.id, (store.listInvitations(c.id)[0] as { id: string }).id, true);
    store.setUserEnabled(a.id, b.id, false);
    expect(store.listGoals(c.id)[0].managerId).toBe(c.id);
  });
});

describe("goal decisions when the manager is disabled or an invitation is answered", () => {
  it("disabling the only enabled member archives the goal and closes the disabled members too", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(b.id, g, "goal_c");
    store.respondInvitation(c.id, (store.listInvitations(c.id)[0] as { id: string }).id, true);
    store.setUserEnabled(a.id, c.id, false);
    store.setUserEnabled(a.id, b.id, false);
    expect(store.listGoals(c.id)).toHaveLength(0);
    store.setUserEnabled(a.id, c.id, true);
    expect(store.listGoals(c.id)).toHaveLength(0);
  });
  it("declining an invitation to an archived goal records the answer and adds no member", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash");
    const g = store.createGoal(a.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(a.id, g, "goal_b");
    const membershipId = (store.listInvitations(b.id)[0] as { id: string }).id;
    store.changeMembership(a.id, g, a.id, "leave");
    expect(() => store.respondInvitation(b.id, membershipId, false)).not.toThrow();
    expect(() => store.respondInvitation(b.id, membershipId, true)).toThrow();
    expect(store.listGoals(b.id)).toHaveLength(0);
  });
});
