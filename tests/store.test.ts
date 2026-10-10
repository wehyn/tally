import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/lib/store";

let database: Database.Database;
let store: ReturnType<typeof createStore>;
beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
});
afterEach(() => database.close());

describe("owner-scoped ledger", () => {
  it("seeds categories and books income, expense, and transfers without inflating totals", () => {
    const alice = store.registerUser("alice", "hash-a");
    const categories = store.listCategories(alice.id);
    expect(categories.filter((category) => category.type === "income").map((c) => c.name)).toEqual(["Salary", "Other income"]);
    expect(categories.filter((category) => category.type === "expense").map((c) => c.name)).toEqual([
      "Food", "Transport", "Housing", "Utilities", "Health", "Shopping", "Education", "Entertainment", "Travel", "Other",
    ]);

    const cash = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const bank = store.createAccount(alice.id, { name: "Savings", type: "bank", openingMinor: 5000 });
    expect(cash.isDefault).toBe(true);
    expect(bank.isDefault).toBe(false);
    const salary = categories.find((category) => category.name === "Salary")!;
    const food = categories.find((category) => category.name === "Food")!;

    store.createTransaction(alice.id, { kind: "income", amountMinor: 5000, accountId: cash.id, categoryId: salary.id, description: "Pay", date: "2026-10-09" });
    store.createTransaction(alice.id, { kind: "expense", amountMinor: 2000, accountId: cash.id, categoryId: food.id, description: "Lunch", date: "2026-10-09" });
    store.createTransaction(alice.id, { kind: "transfer", amountMinor: 1000, accountId: cash.id, destinationAccountId: bank.id, description: "Move to savings", date: "2026-10-09" });

    const dashboard = store.getDashboard(alice.id, "2026-10-01", "2026-10-31");
    expect(dashboard.incomeMinor).toBe(5000);
    expect(dashboard.spendingMinor).toBe(2000);
    expect(dashboard.accounts.map((account) => [account.name, account.balanceMinor])).toEqual([["Wallet", 12000], ["Savings", 6000]]);
  });

  it("calculates asset totals and weights from positive account balances", () => {
    const user = store.registerUser("asset_weights", "hash");
    const cash = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 6000 });
    const bank = store.createAccount(user.id, { name: "Savings", type: "bank", openingMinor: 4000 });
    const overdrawn = store.createAccount(user.id, { name: "Overdrawn", type: "bank", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    store.createTransaction(user.id, { kind: "expense", amountMinor: 1500, accountId: overdrawn.id, categoryId: food.id, description: "Fee", date: "2026-10-09" });

    const dashboard = store.getDashboard(user.id, "2026-10-01", "2026-10-31") as unknown as {
      assetTotalMinor?: string;
      assetWeights?: Record<string, number>;
    };
    expect(dashboard.assetTotalMinor).toBe("10000");
    expect(dashboard.assetWeights).toEqual({ [cash.id]: 6000, [bank.id]: 4000, [overdrawn.id]: 0 });
  });

  it("assigns category icons, persists edits, and includes the icon in recent transactions", () => {
    const alice = store.registerUser("category_icons", "hash-a");
    const bob = store.registerUser("category_other_owner", "hash-b");
    const food = store.listCategories(alice.id).find((category) => category.name === "Food")!;
    expect(food.icon).toBe("utensils");

    const pets = store.createCategory(alice.id, { name: "Pet care", type: "expense", icon: "heart-pulse" });
    expect(pets.icon).toBe("heart-pulse");
    const updated = store.updateCategory(alice.id, pets.id, { name: "Pets", icon: "piggy-bank" });
    expect(updated).toMatchObject({ id: pets.id, name: "Pets", type: "expense", icon: "piggy-bank" });
    expect(() => store.updateCategory(bob.id, pets.id, { icon: "tag" })).toThrow(/not found/i);
    expect(() => store.updateCategory(alice.id, pets.id, { icon: "not-an-icon" as never })).toThrow(/icon/i);

    const wallet = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    store.createTransaction(alice.id, { kind: "expense", amountMinor: 2500, accountId: wallet.id, categoryId: pets.id, description: "Pet food", date: "2026-10-09" });
    expect(store.getDashboard(alice.id, "2026-10-01", "2026-10-31").transactions[0]).toMatchObject({
      categoryName: "Pets", categoryIcon: "piggy-bank",
    });
  });

  it("adds a nullable time column to legacy transactions without inventing event times", () => {
    const user = store.registerUser("legacy_transaction", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const transaction = store.createTransaction(user.id, {
      kind: "expense", amountMinor: 25000, accountId: wallet.id, categoryId: food.id,
      description: "Lunch", date: "2026-10-09", time: "12:15",
    });

    database.exec("ALTER TABLE transactions DROP COLUMN time");
    store.migrate();

    const columns = database.pragma("table_info(transactions)") as { name: string }[];
    expect(columns.some((column) => column.name === "time")).toBe(true);
    expect(store.getTransaction(user.id, transaction.id)).toMatchObject({ description: "Lunch", date: "2026-10-09", time: null });
  });

  it("keeps recent activity global while period analytics stay date-scoped", () => {
    const user = store.registerUser("recent_activity", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;

    store.createTransaction(user.id, {
      kind: "expense", amountMinor: 7000, accountId: wallet.id, categoryId: food.id,
      description: "November lunch", date: "2025-11-18", source: "assistant",
    });
    store.createTransaction(user.id, {
      kind: "expense", amountMinor: 8000, accountId: wallet.id, categoryId: food.id,
      description: "February lunch", date: "2026-02-20", source: "assistant",
    });
    store.createTransaction(user.id, {
      kind: "expense", amountMinor: 25000, accountId: wallet.id, categoryId: food.id,
      description: "Current lunch", date: "2026-10-09",
    });

    const dashboard = store.getDashboard(user.id, "2026-10-01", "2026-10-09");

    expect(dashboard.spendingMinor).toBe(25000);
    expect(dashboard.categorySpending).toEqual([{ id: food.id, name: "Food", amountMinor: 25000 }]);
    expect(dashboard.transactions.map((transaction) => transaction.description)).toEqual([
      "Current lunch", "February lunch", "November lunch",
    ]);
  });

  it("requires matching provider disclosure consent before hosted assistant access", () => {
    const user = store.registerUser("consent_user", "hash");
    expect(store.getAssistantOptIn(user.id, "current-disclosure")).toBe(false);
    store.setAssistantConsent(user.id, "current-disclosure");
    expect(store.getAssistantOptIn(user.id, "current-disclosure")).toBe(true);
    expect(store.getAssistantOptIn(user.id, "changed-disclosure")).toBe(false);
    store.setAssistantConsent(user.id, null);
    expect(store.getAssistantOptIn(user.id, "current-disclosure")).toBe(false);
  });

  it("persists whether an assistant reply is awaiting a user follow-up", () => {
    const user = store.registerUser("followup_user", "hash");
    const conversationId = store.createConversation(user.id, "Lunch");
    store.addMessage(user.id, conversationId, "assistant", "What amount for lunch?", undefined, true);
    expect(store.getConversation(user.id, conversationId)?.messages[0]).toMatchObject({ needsFollowup: true, content: "What amount for lunch?" });
  });

  it("does not permit a transaction to use another user's financial account", () => {
    const alice = store.registerUser("alice2", "hash-a");
    const bob = store.registerUser("bob2", "hash-b");
    const account = store.createAccount(alice.id, { name: "Private", type: "cash", openingMinor: 0 });
    const category = store.listCategories(bob.id).find((entry) => entry.name === "Food")!;
    expect(() => store.createTransaction(bob.id, {
      kind: "expense", amountMinor: 100, accountId: account.id, categoryId: category.id, description: "Attempt", date: "2026-10-09",
    })).toThrow(/owned/);
  });

  it("completes a goal at target and resumes it only after the manager raises the target", () => {
    const alice = store.registerUser("goal_owner", "hash");
    const goalId = store.createGoal(alice.id, { name: "New laptop", targetMinor: 10000 });
    store.addContribution(alice.id, goalId, { amountMinor: 10000, date: "2026-10-09" });
    expect(store.listGoals(alice.id)[0].status).toBe("completed");
    expect(() => store.addContribution(alice.id, goalId, { amountMinor: 100, date: "2026-10-09" })).toThrow(/complete/);
    store.updateGoal(alice.id, goalId, { targetMinor: 20000 });
    expect(store.listGoals(alice.id)[0].status).toBe("active");
    expect(() => store.addContribution(alice.id, goalId, { amountMinor: 100, date: "2026-10-09" })).not.toThrow();
  });

  it("prevents former goal members from mutating preserved contributions", () => {
    const alice = store.registerUser("goal_manager", "hash-a");
    const bob = store.registerUser("goal_member", "hash-b");
    const goalId = store.createGoal(alice.id, { name: "Shared trip", targetMinor: 100_000 });
    store.inviteToGoal(alice.id, goalId, bob.username);
    const invitation = store.listInvitations(bob.id)[0] as { id: string };
    store.respondInvitation(bob.id, invitation.id, true);
    const contributionId = store.addContribution(bob.id, goalId, { amountMinor: 2500, date: "2026-10-09" });
    store.changeMembership(alice.id, goalId, bob.id, "remove");

    expect(() => store.updateContribution(bob.id, contributionId, { amountMinor: 5000 })).toThrow(/goal not found/i);
    expect(() => store.deleteContribution(bob.id, contributionId)).toThrow(/goal not found/i);
    expect(store.listGoals(alice.id)[0].contributions).toMatchObject([{ userId: bob.id, amountMinor: 2500 }]);
  });

  it("rejects ledger and goal totals beyond exact minor-unit range", () => {
    const alice = store.registerUser("safe_money", "hash-a");
    const cash = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const salary = store.listCategories(alice.id).find((item) => item.name === "Salary")!;
    store.createTransaction(alice.id, { kind: "income", amountMinor: Number.MAX_SAFE_INTEGER, accountId: cash.id, categoryId: salary.id, description: "Maximum", date: "2026-10-09" });
    expect(() => store.createTransaction(alice.id, { kind: "income", amountMinor: 1, accountId: cash.id, categoryId: salary.id, description: "Overflow", date: "2026-10-09" })).toThrow(/supported exact PHP minor-unit range/i);
    expect(store.getDashboard(alice.id, "2026-10-01", "2026-10-31").incomeMinor).toBe(Number.MAX_SAFE_INTEGER);

    const goalId = store.createGoal(alice.id, { name: "Goal", targetMinor: Number.MAX_SAFE_INTEGER });
    store.addContribution(alice.id, goalId, { amountMinor: 1, date: "2026-10-09" });
    expect(() => store.addContribution(alice.id, goalId, { amountMinor: Number.MAX_SAFE_INTEGER, date: "2026-10-09" })).toThrow(/supported exact PHP minor-unit range/i);
  });

  it("hands a departing manager role to the first active accepted invitee", () => {
    const alice = store.registerUser("alice3", "hash-a");
    const bob = store.registerUser("bob3", "hash-b");
    const goalId = store.createGoal(alice.id, { name: "Island trip", targetMinor: 100_000 });
    store.inviteToGoal(alice.id, goalId, bob.username);
    const invitation = store.listInvitations(bob.id)[0] as { id: string };
    store.respondInvitation(bob.id, invitation.id, true);
    store.addContribution(alice.id, goalId, { amountMinor: 5000, date: "2026-10-09" });
    store.changeMembership(alice.id, goalId, alice.id, "leave");

    const [goal] = store.listGoals(bob.id);
    expect(goal.managerId).toBe(bob.id);
    expect(goal.contributions).toMatchObject([{ memberName: "alice3", amountMinor: 5000 }]);
  });

  it("archives a goal on admin deletion if no invitee accepted and preserves former-member contributions", () => {
    const alice = store.registerUser("alice4", "hash-a");
    const bob = store.registerUser("bob4", "hash-b");
    const goalId = store.createGoal(alice.id, { name: "Emergency fund", targetMinor: 100_000 });
    store.addContribution(alice.id, goalId, { amountMinor: 7500, date: "2026-10-09" });
    store.inviteToGoal(alice.id, goalId, bob.username);
    expect(() => store.deleteAccountOwner(alice.id)).toThrow(/admin access before deleting/);
    store.deleteAccountOwner(alice.id, bob.id);

    expect(database.prepare("SELECT status,manager_id FROM goals WHERE id=?").get(goalId)).toEqual({ status: "archived", manager_id: null });
    expect(database.prepare("SELECT user_id,member_name,amount_minor FROM goal_contributions WHERE goal_id=?").get(goalId)).toEqual({ user_id: null, member_name: "Former member", amount_minor: 7500 });
    expect(store.getUserById(bob.id)?.role).toBe("admin");
  });
});
