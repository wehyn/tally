// Replays the Goals.tla counterexamples and key rules against the real store (in-memory SQLite).
// Run from the repo root with the command in SKILL.md. Imports are relative to the repo root's tests/ folder,
// so the skill copies this file to tests/ for the run and deletes it afterwards.
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/lib/store";

let store: ReturnType<typeof createStore>;
beforeEach(() => { store = createStore(new Database(":memory:")); store.migrate(); });

const admin = () => store.registerUser("goal_admin", "hash");

describe("rules that hold (ManagerMatchesStatus, CompletedIffTargetMet, NoContributionUnlessActive)", () => {
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

describe("findings (Goals.tla goals-findings.cfg)", () => {
  // Finding 1: ArchivedGoalHasNoAcceptedMember. `it.fails`: passes while the bug exists, fails once it is fixed (then update the model, docs and this test): an invitation outlives the archive.
  it.fails("a pending invitation cannot be accepted after the goal is archived", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash");
    const g = store.createGoal(a.id, { name: "Trip", targetMinor: 1000 });
    store.inviteToGoal(a.id, g, "goal_b");
    const membershipId = (store.listInvitations(b.id)[0] as { id: string }).id;
    store.changeMembership(a.id, g, a.id, "leave"); // nobody accepted: goal archived
    expect(() => store.respondInvitation(b.id, membershipId, true)).toThrow();
  });
  // Finding 2: ManagerIsEnabled. `it.fails`: passes while the bug exists, fails once it is fixed (then update the model, docs and this test): disabling a manager runs no succession.
  it.fails("a disabled manager does not stay manager of a live goal", () => {
    const a = admin(); const b = store.registerUser("goal_b", "hash"); const c = store.registerUser("goal_c", "hash");
    void c;
    const g = store.createGoal(b.id, { name: "Trip", targetMinor: 1000 });
    store.setUserEnabled(a.id, b.id, false);
    const goal = store.listGoals(b.id)[0];
    expect(goal.status === "archived" || goal.managerId !== b.id).toBe(true);
    void g;
  });
});
