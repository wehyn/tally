import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/lib/store";

let store: ReturnType<typeof createStore>;
let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); store = createStore(db); store.migrate(); });

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

const goalRow = (id: string) => db.prepare("SELECT status,manager_id AS managerId FROM goals WHERE id=?").get(id);
const memberStatuses = (id: string) => (db.prepare("SELECT username_snapshot AS name,status FROM goal_members WHERE goal_id=?").all(id) as { name: string; status: string }[])
  .map((row) => `${row.name}:${row.status}`).sort();

describe("goal decisions when the manager is disabled or an invitation is answered", () => {
  it("a goal only the disabled user belongs to comes back whole when they are re-enabled", () => {
    const a = admin(); const bob = store.registerUser("goal_bob", "hash");
    const g = store.createGoal(bob.id, { name: "Emergency fund", targetMinor: 100_000 });
    store.addContribution(bob.id, g, { amountMinor: 40_000, date: "2026-11-01" });
    store.setUserEnabled(a.id, bob.id, false);
    store.setUserEnabled(a.id, bob.id, true);
    expect(store.listGoals(bob.id)).toMatchObject([{ id: g, name: "Emergency fund", status: "active", managerId: bob.id, raisedMinor: 40_000 }]);
    expect(() => store.addContribution(bob.id, g, { amountMinor: 1, date: "2026-11-02" })).not.toThrow();
    expect(() => store.updateGoal(bob.id, g, { name: "Rainy day fund" })).not.toThrow();
  });
  it("disabling the only enabled member keeps the goal, its manager and every membership, so re-enabling restores it", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(b.id, g, "goal_c");
    store.respondInvitation(c.id, (store.listInvitations(c.id)[0] as { id: string }).id, true);
    store.setUserEnabled(a.id, c.id, false);
    store.setUserEnabled(a.id, b.id, false);
    expect(goalRow(g)).toEqual({ status: "active", managerId: b.id });
    expect(memberStatuses(g)).toEqual(["goal_b:accepted", "goal_c:accepted"]);
    store.setUserEnabled(a.id, b.id, true);
    expect(store.listGoals(b.id)[0]).toMatchObject({ id: g, managerId: b.id });
    store.setUserEnabled(a.id, c.id, true);
    expect(store.listGoals(c.id)[0]).toMatchObject({ id: g, managerId: b.id });
  });
  it("enabling a member hands a goal held by a disabled manager to them", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(b.id, g, "goal_c");
    store.respondInvitation(c.id, (store.listInvitations(c.id)[0] as { id: string }).id, true);
    store.setUserEnabled(a.id, c.id, false);
    store.setUserEnabled(a.id, b.id, false);
    store.setUserEnabled(a.id, c.id, true);
    expect(goalRow(g)).toEqual({ status: "active", managerId: c.id });
    store.setUserEnabled(a.id, b.id, true);
    expect(goalRow(g)).toEqual({ status: "active", managerId: c.id });
    expect(memberStatuses(g)).toEqual(["goal_b:accepted", "goal_c:accepted"]);
  });
  it("accepting an invitation hands a goal held by a disabled manager to the new member", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(b.id, g, "goal_c");
    store.setUserEnabled(a.id, b.id, false);
    expect(goalRow(g)).toEqual({ status: "active", managerId: b.id });
    store.respondInvitation(c.id, (store.listInvitations(c.id)[0] as { id: string }).id, true);
    expect(goalRow(g)).toEqual({ status: "active", managerId: c.id });
  });
  it("deleting the account of the only enabled member still archives the goal and closes the disabled members", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(b.id, g, "goal_c");
    store.respondInvitation(c.id, (store.listInvitations(c.id)[0] as { id: string }).id, true);
    store.setUserEnabled(a.id, c.id, false);
    store.deleteAccountOwner(b.id);
    expect(goalRow(g)).toEqual({ status: "archived", managerId: null });
    expect(memberStatuses(g)).toEqual(["Former member:former", "goal_c:left"]);
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
