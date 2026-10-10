import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/lib/store";
import { todayInManila } from "../src/lib/dates";

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
    expect(dashboard).not.toHaveProperty("categorySpending");
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

describe("recurring bills", () => {
  it("persists a selected icon and defaults omitted icons to Calendar", () => {
    const user = store.registerUser("bill_icons", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const input = { name: "Internet", amountMinor: 1500, frequency: "monthly" as const, nextDueDate: "2099-01-01", accountId: account.id, categoryId: category.id };
    const selected = store.createBill(user.id, { ...input, icon: "wifi" });
    const defaulted = store.createBill(user.id, { ...input, name: "Calendar bill" });

    expect(selected.icon).toBe("wifi");
    expect(store.updateBill(user.id, selected.id, { icon: "music" }, selected.nextDueDate).icon).toBe("music");
    expect(defaulted.icon).toBe("calendar");
    expect(() => store.updateBill(user.id, selected.id, { icon: "custom" as never }, selected.nextDueDate)).toThrow(/icon/i);
  });

  it("adds Calendar icons to existing bills when migrating", () => {
    const user = store.registerUser("bill_icon_migration", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 1500, frequency: "monthly", nextDueDate: "2099-01-01", accountId: account.id, categoryId: category.id });
    const columns = database.pragma("table_info(bills)") as { name: string }[];
    if (columns.some((column) => column.name === "icon")) {
      database.prepare("UPDATE bills SET icon='wifi' WHERE id=?").run(bill.id);
      database.exec("ALTER TABLE bills DROP COLUMN icon");
    }

    store.migrate();

    expect((database.pragma("table_info(bills)") as { name: string }[]).some((column) => column.name === "icon")).toBe(true);
    expect(store.listBills(user.id).find((item) => item.id === bill.id)?.icon).toBe("calendar");
  });

  it("keeps bill listing and updates owner-scoped", () => {
    const alice = store.registerUser("bill_alice", "hash");
    const bob = store.registerUser("bill_bob", "hash");
    const account = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const food = store.listCategories(alice.id).find((category) => category.name === "Food")!;
    const bill = store.createBill(alice.id, {
      name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2099-01-31", accountId: account.id, categoryId: food.id,
    });
    expect(store.listBills(bob.id)).toEqual([]);
    expect(() => store.updateBill(bob.id, bill.id, { name: "Changed" }, bill.nextDueDate)).toThrow(/not found/i);
    database.prepare("UPDATE bills SET next_due_date='2000-01-01' WHERE id=?").run(bill.id);
    expect(store.updateBill(alice.id, bill.id, { name: "Internet service" }, "2000-01-01")).toMatchObject({ nextDueDate: "2000-01-01", name: "Internet service" });
    expect(() => store.updateBill(alice.id, bill.id, { nextDueDate: "1999-01-01" }, "2000-01-01")).toThrow(/today or later/i);
  });

  it("posts missed occurrences on their scheduled dates and does not repost on retry", () => {
    const user = store.registerUser("bill_catchup", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2099-01-31", accountId: account.id, categoryId: food.id });
    expect(store.processDueBills("2099-03-31").processed).toBe(3);
    expect(store.processDueBills("2099-03-31").processed).toBe(0);
    expect(store.listTransactions(user.id, { start: "2099-01-31", end: "2099-03-31" }, 10, { kind: "expense" }).map(({ description, amountMinor, date, accountId, categoryId }) => ({ description, amountMinor, date, accountId, categoryId })))
      .toEqual([{ description: "Internet", amountMinor: 2500, date: "2099-03-31", accountId: account.id, categoryId: food.id }, { description: "Internet", amountMinor: 2500, date: "2099-02-28", accountId: account.id, categoryId: food.id }, { description: "Internet", amountMinor: 2500, date: "2099-01-31", accountId: account.id, categoryId: food.id }]);
    expect(store.listBills(user.id).find((entry) => entry.id === bill.id)?.nextDueDate).toBe("2099-04-30");
  });

  it("keeps archived bills browsable and excludes them from posting", () => {
    const user = store.registerUser("bill_archived", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const bill = store.createBill(user.id, { name: "Music", amountMinor: 500, frequency: "weekly", nextDueDate: "2099-01-01", accountId: account.id, categoryId: food.id });
    store.archiveBill(user.id, bill.id);
    expect(store.listBills(user.id).find((entry) => entry.id === bill.id)?.archivedAt).toBeTruthy();
    expect(store.processDueBills("2099-12-31").processed).toBe(0);
    expect(store.listTransactions(user.id, undefined, 10, { kind: "expense" })).toEqual([]);
  });

  it("lets a generated transaction change without changing the bill defaults", () => {
    const user = store.registerUser("bill_tx_edit", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const bill = store.createBill(user.id, { name: "Music", amountMinor: 500, frequency: "weekly", nextDueDate: "2099-01-01", accountId: account.id, categoryId: food.id });
    store.processDueBills("2099-01-01");
    const transaction = store.listTransactions(user.id, { start: "2099-01-01", end: "2099-01-01" }, 1)[0];
    store.updateTransaction(user.id, transaction.id, { ...transaction, amountMinor: 700, description: "Actual subscription" });
    expect(store.listBills(user.id).find((entry) => entry.id === bill.id)).toMatchObject({ amountMinor: 500, name: "Music", nextDueDate: "2099-01-08" });
  });

  it("reanchors a bill when its cadence and due date change", () => {
    const user = store.registerUser("bill_reanchor", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const bill = store.createBill(user.id, { name: "Rent", amountMinor: 1000, frequency: "weekly", nextDueDate: "2099-01-01", accountId: account.id, categoryId: food.id });
    store.updateBill(user.id, bill.id, { frequency: "monthly", nextDueDate: "2099-01-31" }, bill.nextDueDate);
    expect(store.processDueBills("2099-02-28").processed).toBe(2);
    expect(store.listBills(user.id)[0]).toMatchObject({ nextDueDate: "2099-03-31", anchorDay: 31, anchorMonth: 1 });
  });

  it("rolls back posting and advancement when exact ledger totals overflow", () => {
    const user = store.registerUser("bill_overflow", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const today = todayInManila();
    store.createTransaction(user.id, { kind: "expense", amountMinor: Number.MAX_SAFE_INTEGER, accountId: account.id, categoryId: food.id, description: "Existing", date: today });
    const bill = store.createBill(user.id, { name: "Small bill", amountMinor: 1, frequency: "weekly", nextDueDate: today, accountId: account.id, categoryId: food.id });
    expect(store.processDueBills(today)).toMatchObject({ processed: 0, failures: [expect.objectContaining({ billId: bill.id, dueDate: today, message: expect.stringContaining("supported exact PHP minor-unit range") })] });
    expect(store.listBills(user.id).find((entry) => entry.id === bill.id)?.nextDueDate).toBe(today);
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id=?").get(user.id)).toEqual({ count: 1 });
  });

  it("records an occurrence failure and continues posting for the next owner", () => {
    const blocked = store.registerUser("bill_blocked_owner", "hash");
    const available = store.registerUser("bill_available_owner", "hash");
    const blockedAccount = store.createAccount(blocked.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const availableAccount = store.createAccount(available.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const blockedFood = store.listCategories(blocked.id).find((category) => category.name === "Food")!;
    const availableFood = store.listCategories(available.id).find((category) => category.name === "Food")!;
    const today = todayInManila();
    store.createTransaction(blocked.id, { kind: "expense", amountMinor: Number.MAX_SAFE_INTEGER, accountId: blockedAccount.id, categoryId: blockedFood.id, description: "At limit", date: today });
    const blockedBill = store.createBill(blocked.id, { name: "Overflow", amountMinor: 1, frequency: "weekly", nextDueDate: today, accountId: blockedAccount.id, categoryId: blockedFood.id });
    const availableBill = store.createBill(available.id, { name: "Can post", amountMinor: 100, frequency: "weekly", nextDueDate: today, accountId: availableAccount.id, categoryId: availableFood.id });
    const earlierDate = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    database.prepare("UPDATE bills SET next_due_date=? WHERE id=?").run(earlierDate, blockedBill.id);

    const result = store.processDueBills(today);

    expect(result).toMatchObject({ processed: 1, failures: [expect.objectContaining({ billId: blockedBill.id, dueDate: earlierDate })] });
    expect(store.listBills(blocked.id).find((bill) => bill.id === blockedBill.id)?.nextDueDate).toBe(earlierDate);
    expect(store.listTransactions(available.id, { start: today, end: today }, 10, { kind: "expense" })).toMatchObject([{ description: "Can post", amountMinor: 100, date: today }]);
    const expectedNextDate = new Date(Date.parse(`${today}T00:00:00.000Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(store.listBills(available.id).find((bill) => bill.id === availableBill.id)?.nextDueDate).toBe(expectedNextDate);
  });

  it("removes bills before deleting their owner", () => {
    store.registerUser("bill_owner_admin", "hash");
    const user = store.registerUser("bill_owner_delete", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    store.createBill(user.id, { name: "Rent", amountMinor: 100, frequency: "monthly", nextDueDate: todayInManila(), accountId: account.id, categoryId: food.id });
    expect(() => store.deleteAccountOwner(user.id)).not.toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM bills WHERE user_id=?").get(user.id)).toEqual({ count: 0 });
  });

  it("rejects invalid inputs and prevents account deletion while a bill refers to it", () => {
    const user = store.registerUser("bill_validations", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    store.createAccount(user.id, { name: "Bank", type: "bank", openingMinor: 0 });
    const categories = store.listCategories(user.id);
    const food = categories.find((category) => category.name === "Food")!;
    const salary = categories.find((category) => category.name === "Salary")!;
    const today = todayInManila();
    expect(() => store.createBill(user.id, { name: "Bad", amountMinor: 0, frequency: "weekly", nextDueDate: today, accountId: account.id, categoryId: food.id })).toThrow();
    expect(() => store.createBill(user.id, { name: "Bad", amountMinor: 1, frequency: "monthly", nextDueDate: "2026-02-30", accountId: account.id, categoryId: food.id })).toThrow();
    expect(() => store.createBill(user.id, { name: "Bad", amountMinor: 1, frequency: "weekly", nextDueDate: today, accountId: account.id, categoryId: salary.id })).toThrow(/expense/i);
    const bill = store.createBill(user.id, { name: "Valid", amountMinor: 1, frequency: "weekly", nextDueDate: today, accountId: account.id, categoryId: food.id });
    expect(() => store.deleteAccount(user.id, account.id)).toThrow(/bill/i);
    expect(store.listBills(user.id)).toContainEqual(expect.objectContaining({ id: bill.id }));
  });

  it("rejects a bill category owned by another user", () => {
    const alice = store.registerUser("bill_category_owner", "hash");
    const bob = store.registerUser("bill_category_other", "hash");
    const account = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const category = store.listCategories(bob.id).find((entry) => entry.type === "expense")!;
    expect(() => store.createBill(alice.id, { name: "Bad", amountMinor: 1, frequency: "weekly", nextDueDate: todayInManila(), accountId: account.id, categoryId: category.id })).toThrow(/expense category/i);
  });
});
