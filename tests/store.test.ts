import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/lib/store";
import { todayInManila } from "../src/lib/dates";

function restoreLegacyTransactionSchema(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE transactions_legacy (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
          account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
          destination_account_id TEXT REFERENCES financial_accounts(id) ON DELETE RESTRICT,
          category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
          debt_id TEXT REFERENCES debts(id) ON DELETE SET NULL,
          description TEXT NOT NULL, date TEXT NOT NULL, time TEXT, source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','assistant')),
          undo_until TEXT, created_at TEXT NOT NULL,
          CHECK((kind = 'transfer' AND destination_account_id IS NOT NULL AND category_id IS NULL) OR (kind != 'transfer' AND destination_account_id IS NULL AND category_id IS NOT NULL)),
          CHECK(destination_account_id IS NULL OR destination_account_id != account_id)
        );
        INSERT INTO transactions_legacy(rowid,id,user_id,kind,amount_minor,account_id,destination_account_id,category_id,debt_id,description,date,time,source,undo_until,created_at)
          SELECT rowid,id,user_id,kind,amount_minor,account_id,destination_account_id,category_id,debt_id,description,date,time,source,undo_until,created_at FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_legacy RENAME TO transactions;
      `);
    }).immediate();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

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

  it("does not let a generic edit create an unlinked debt repayment", () => {
    const owner = store.registerUser("generic_debt_repayment_edit", "hash");
    const account = store.createAccount(owner.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const incomeCategory = store.listCategories(owner.id).find((category) => category.type === "income")!;
    const income = store.createTransaction(owner.id, {
      kind: "income", amountMinor: 2_500, accountId: account.id, categoryId: incomeCategory.id,
      description: "Payment", date: "2026-10-11",
    });

    expect(() => store.updateTransaction(owner.id, income.id, {
      kind: "debt_repayment", amountMinor: 2_500, accountId: account.id,
      description: "Payment", date: "2026-10-11",
    })).toThrow();

    expect(store.getTransaction(owner.id, income.id)).toMatchObject({ kind: "income", categoryId: incomeCategory.id });
    expect(store.getDashboard(owner.id, "2026-10-01", "2026-10-31")).toMatchObject({
      incomeMinor: 2_500, debtRepaymentMinor: 0,
    });
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(2_500);
  });

  it("rejects deleting a transaction referenced by debt payment history", () => {
    const owner = store.registerUser("debt_payment_delete_guard", "hash");
    const account = store.createAccount(owner.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 2_000 });
    const { transaction } = store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 500, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    });

    expect(() => store.deleteTransaction(owner.id, transaction.id)).toThrow("Linked debt repayments cannot be deleted; delete the debt first.");
    expect(store.getTransaction(owner.id, transaction.id)).not.toBeNull();
  });

  it("sets the opposite safe-integer boundary without changing transaction history", () => {
    const user = store.registerUser("account_balance_boundary", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: Number.MAX_SAFE_INTEGER - 1 });
    const salary = store.listCategories(user.id).find((category) => category.type === "income")!;
    const transaction = store.createTransaction(user.id, {
      kind: "income", amountMinor: 1, accountId: account.id, categoryId: salary.id, description: "Pay", date: "2026-10-09",
    });

    store.updateAccount(user.id, account.id, { balanceMinor: -Number.MAX_SAFE_INTEGER });

    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(-Number.MAX_SAFE_INTEGER);
    expect(store.listTransactions(user.id)).toMatchObject([{ id: transaction.id, kind: "income", amountMinor: 1, accountId: account.id }]);
  });

  it("keeps balances exact after 1,025 maximum transfers and balance resets", () => {
    const amountMinor = Number.MAX_SAFE_INTEGER;
    const user = store.registerUser("account_balance_transfer_range", "hash");
    const source = store.createAccount(user.id, { name: "Source", type: "cash", openingMinor: amountMinor });
    const destination = store.createAccount(user.id, { name: "Destination", type: "bank", openingMinor: 0 });
    const transferIds: string[] = [];

    for (let index = 0; index < 1_025; index++) {
      const transfer = store.createTransaction(user.id, {
        kind: "transfer", amountMinor, accountId: source.id, destinationAccountId: destination.id,
        description: "Balance reset", date: "2026-10-09",
      });
      transferIds.push(transfer.id);
      store.updateAccount(user.id, destination.id, { balanceMinor: 0 });
      store.updateAccount(user.id, source.id, { balanceMinor: amountMinor });
    }

    expect(Object.fromEntries(store.listAccounts(user.id).map(({ id, balanceMinor }) => [id, balanceMinor])))
      .toEqual({ [source.id]: amountMinor, [destination.id]: 0 });

    const expectedAdjustmentMinor = (BigInt(amountMinor) * 1_025n).toString();
    const adjustments = database.prepare(`SELECT id,typeof(balance_adjustment_minor_exact) AS storage_type,
      balance_adjustment_minor_exact FROM financial_accounts WHERE user_id=?`).all(user.id) as {
        id: string; storage_type: string; balance_adjustment_minor_exact: string;
      }[];
    expect(Object.fromEntries(adjustments.map(({ id, storage_type, balance_adjustment_minor_exact }) => [id, {
      storageType: storage_type, value: balance_adjustment_minor_exact,
    }])))
      .toEqual({
        [source.id]: { storageType: "text", value: expectedAdjustmentMinor },
        [destination.id]: { storageType: "text", value: `-${expectedAdjustmentMinor}` },
      });

    const transactions = database.prepare(`SELECT id,kind,amount_minor,account_id,destination_account_id
      FROM transactions WHERE user_id=?`).all(user.id) as {
        id: string; kind: string; amount_minor: number; account_id: string; destination_account_id: string;
      }[];
    expect(transactions).toHaveLength(1_025);
    expect(new Set(transactions.map(({ id }) => id))).toEqual(new Set(transferIds));
    expect(transactions.every((transaction) => transaction.kind === "transfer" && transaction.amount_minor === amountMinor
      && transaction.account_id === source.id && transaction.destination_account_id === destination.id)).toBe(true);
  }, 30_000);

  it("migrates legacy integer balance adjustments without changing balances or transaction rows", () => {
    const alice = store.registerUser("legacy_balance_alice", "hash-a");
    const bob = store.registerUser("legacy_balance_bob", "hash-b");
    const aliceAccount = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 10_000 });
    const bobAccount = store.createAccount(bob.id, { name: "Savings", type: "bank", openingMinor: 2_000 });
    const aliceIncome = store.listCategories(alice.id).find((category) => category.type === "income")!;
    const bobExpense = store.listCategories(bob.id).find((category) => category.type === "expense")!;
    store.createTransaction(alice.id, {
      kind: "income", amountMinor: 1_250, accountId: aliceAccount.id, categoryId: aliceIncome.id,
      description: "Pay", date: "2026-10-09",
    });
    store.createTransaction(bob.id, {
      kind: "expense", amountMinor: 500, accountId: bobAccount.id, categoryId: bobExpense.id,
      description: "Lunch", date: "2026-10-09",
    });

    const accountColumns = database.pragma("table_info(financial_accounts)") as { name: string }[];
    if (accountColumns.some((column) => column.name === "balance_adjustment_minor_exact")) {
      database.exec("ALTER TABLE financial_accounts DROP COLUMN balance_adjustment_minor_exact");
    }
    if (!accountColumns.some((column) => column.name === "balance_adjustment_minor")) {
      database.exec("ALTER TABLE financial_accounts ADD COLUMN balance_adjustment_minor INTEGER NOT NULL DEFAULT 0");
    }
    database.prepare("UPDATE financial_accounts SET balance_adjustment_minor=? WHERE id=?").run(-2_500, aliceAccount.id);
    database.prepare("UPDATE financial_accounts SET balance_adjustment_minor=? WHERE id=?").run(350, bobAccount.id);
    const transactionRows = database.prepare("SELECT id,user_id,kind,amount_minor,account_id,category_id FROM transactions ORDER BY id").all();

    store.migrate();

    expect(store.listAccounts(alice.id).map(({ id, balanceMinor }) => [id, balanceMinor])).toEqual([[aliceAccount.id, 8_750]]);
    expect(store.listAccounts(bob.id).map(({ id, balanceMinor }) => [id, balanceMinor])).toEqual([[bobAccount.id, 1_850]]);
    expect(database.prepare(`SELECT id,typeof(balance_adjustment_minor_exact) AS storage_type,
      balance_adjustment_minor_exact FROM financial_accounts ORDER BY id`).all()).toEqual([
      { id: aliceAccount.id, storage_type: "text", balance_adjustment_minor_exact: "-2500" },
      { id: bobAccount.id, storage_type: "text", balance_adjustment_minor_exact: "350" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(database.prepare("SELECT id,user_id,kind,amount_minor,account_id,category_id FROM transactions ORDER BY id").all())
      .toEqual(transactionRows);
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

  it("persists custom bill emojis and colors while partial edits keep omitted icon values", () => {
    const user = store.registerUser("custom_bill_icon", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const utilities = store.listCategories(user.id).find((category) => category.name === "Utilities")!;
    const bill = store.createBill(user.id, {
      name: "Netflix", amountMinor: 15900, frequency: "monthly", nextDueDate: "2099-01-01",
      accountId: wallet.id, categoryId: utilities.id, icon: "netflix",
      iconEmoji: "🧾", iconForegroundColor: "#ffffff", iconBackgroundColor: "#e50914",
    });

    expect(bill).toMatchObject({
      icon: "netflix", iconEmoji: "🧾", iconForegroundColor: "#ffffff", iconBackgroundColor: "#e50914",
    });
    expect(store.updateBill(user.id, bill.id, { iconEmoji: null }, bill.nextDueDate)).toMatchObject({
      icon: "netflix", iconEmoji: null, iconForegroundColor: "#ffffff", iconBackgroundColor: "#e50914",
    });
  });

  it("rejects unsafe bill icon values before writing them", () => {
    const user = store.registerUser("invalid_bill_icon", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const utilities = store.listCategories(user.id).find((category) => category.name === "Utilities")!;
    const input = {
      name: "Internet", amountMinor: 5000, frequency: "monthly" as const, nextDueDate: "2099-01-01",
      accountId: wallet.id, categoryId: utilities.id,
    };

    expect(() => store.createBill(user.id, { ...input, icon: "unknown" as never })).toThrow(/icon/i);
    expect(() => store.createBill(user.id, { ...input, iconEmoji: "not emoji" })).toThrow(/emoji/i);
    expect(() => store.createBill(user.id, { ...input, iconBackgroundColor: "red" })).toThrow(/color/i);
  });

  it("uses safe fallback icon values for malformed data already stored on a bill", () => {
    const user = store.registerUser("malformed_bill_icon", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const utilities = store.listCategories(user.id).find((category) => category.name === "Utilities")!;
    const bill = store.createBill(user.id, {
      name: "Internet", amountMinor: 5000, frequency: "monthly", nextDueDate: "2099-01-01", accountId: wallet.id, categoryId: utilities.id,
      icon: "pldt", iconEmoji: "📶", iconForegroundColor: "#ffffff", iconBackgroundColor: "#123456",
    });
    database.prepare("UPDATE bills SET icon='unknown',icon_emoji='plain text',icon_foreground_color='red',icon_background_color='url(javascript:alert(1))' WHERE id=?").run(bill.id);

    expect(store.listBills(user.id)).toMatchObject([{
      icon: "calendar", iconEmoji: null, iconForegroundColor: "#5e9872", iconBackgroundColor: "#f0f5f0",
    }]);
  });

  it("adds default custom-icon fields to legacy bills without changing their selected preset", () => {
    const user = store.registerUser("legacy_bill_icon", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const utilities = store.listCategories(user.id).find((category) => category.name === "Utilities")!;
    database.exec("DROP TABLE bills");
    database.exec(`CREATE TABLE bills (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      frequency TEXT NOT NULL CHECK(frequency IN ('weekly','monthly','yearly')), next_due_date TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'calendar', anchor_day INTEGER NOT NULL, anchor_month INTEGER NOT NULL,
      account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    database.prepare(`INSERT INTO bills(id,user_id,name,amount_minor,frequency,next_due_date,icon,anchor_day,anchor_month,account_id,category_id,created_at,updated_at)
      VALUES('legacy-bill',?,'Home internet',5000,'monthly','2099-01-01','wifi',1,1,?,?,?,?)`)
      .run(user.id, wallet.id, utilities.id, "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z");

    store.migrate();

    expect(store.listBills(user.id)).toMatchObject([{
      id: "legacy-bill", icon: "wifi", iconEmoji: null,
      iconForegroundColor: "#5e9872", iconBackgroundColor: "#f0f5f0",
    }]);
  });

  it("adds a nullable time column to legacy transactions without inventing event times", () => {
    const user = store.registerUser("legacy_transaction", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const transaction = store.createTransaction(user.id, {
      kind: "expense", amountMinor: 25000, accountId: wallet.id, categoryId: food.id,
      description: "Lunch", date: "2026-10-09", time: "12:15",
    });

    database.exec("DROP INDEX transactions_owner_history");
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

describe("Shortcut credential storage", () => {
  it("migrates legacy users with a hash field", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL DEFAULT 1,
      assistant_opt_in INTEGER NOT NULL DEFAULT 0, reset_token_hash TEXT, reset_expires_at TEXT,
      default_account_id TEXT, created_at TEXT NOT NULL
    )`);

    createStore(legacy).migrate();

    const columns = (legacy.pragma("table_info(users)") as { name: string }[]).map(({ name }) => name);
    legacy.close();
    expect(columns).toContain("shortcut_credential_hash");
  });

  it("resolves only an enabled owner and removes a revoked hash", () => {
    const admin = store.registerUser("shortcut_hash_admin", "admin-hash");
    const owner = store.registerUser("shortcut_hash_owner", "owner-hash");

    store.setShortcutCredentialHash(owner.id, "stored-sha256-hash");

    expect(database.prepare("SELECT shortcut_credential_hash FROM users WHERE id=?").get(owner.id)).toEqual({
      shortcut_credential_hash: "stored-sha256-hash",
    });
    expect(store.findEnabledUserByShortcutCredentialHash("stored-sha256-hash")).toEqual({ id: owner.id });
    store.setUserEnabled(admin.id, owner.id, false);
    expect(store.findEnabledUserByShortcutCredentialHash("stored-sha256-hash")).toBeNull();
    store.setShortcutCredentialHash(owner.id, null);
    expect(store.hasShortcutCredential(owner.id)).toBe(false);
  });
});

describe("recurring bills", () => {
  it("migrates legacy bills as open-ended without changing their schedule or transactions", () => {
    const user = store.registerUser("bill_end_date_migration", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 1500, frequency: "monthly", nextDueDate: "2099-01-31", accountId: account.id, categoryId: category.id });
    const transaction = store.createTransaction(user.id, { kind: "expense", amountMinor: 1500, accountId: account.id, categoryId: category.id, description: "Internet", date: "2098-12-31" });
    const billColumns = database.pragma("table_info(bills)") as { name: string }[];
    if (billColumns.some((column) => column.name === "end_date")) database.exec("ALTER TABLE bills DROP COLUMN end_date");

    store.migrate();

    expect(store.listBills(user.id)).toContainEqual(expect.objectContaining({ id: bill.id, endDate: null, nextDueDate: "2099-01-31", frequency: "monthly" }));
    expect(store.listTransactions(user.id, { start: "2098-12-31", end: "2098-12-31" }, 10)).toContainEqual(expect.objectContaining({ id: transaction.id, description: "Internet", date: "2098-12-31" }));
  });

  it("posts the final occurrence on the inclusive end date and archives afterward", () => {
    const user = store.registerUser("bill_inclusive_end", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 1500, frequency: "monthly", nextDueDate: "2099-01-31", endDate: "2099-02-28", accountId: account.id, categoryId: category.id });

    const result = store.processDueBills("2099-03-31");

    expect(result).toMatchObject({ processed: 2, failures: [] });
    expect(store.listTransactions(user.id, { start: "2099-01-01", end: "2099-03-31" }, 10, { kind: "expense" }).map((item) => item.date)).toEqual(["2099-02-28", "2099-01-31"]);
    expect(store.listBills(user.id)).toContainEqual(expect.objectContaining({ id: bill.id, archivedAt: expect.any(String), nextDueDate: "2099-03-31", endDate: "2099-02-28" }));
  });

  it("archives immediately when an updated end date precedes the next due date", () => {
    const user = store.registerUser("bill_update_end", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10000 });
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 1500, frequency: "monthly", nextDueDate: "2099-01-31", accountId: account.id, categoryId: category.id });

    const updated = store.updateBill(user.id, bill.id, { endDate: "2099-01-30" }, bill.nextDueDate);

    expect(updated).toMatchObject({ endDate: "2099-01-30", archivedAt: expect.any(String), nextDueDate: "2099-01-31" });
    expect(store.processDueBills("2099-02-28")).toMatchObject({ processed: 0, failures: [] });
    expect(store.listTransactions(user.id, { start: "2099-01-01", end: "2099-02-28" }, 10, { kind: "expense" })).toEqual([]);
  });

  it("rejects an invalid end date or one before the first due date", () => {
    const user = store.registerUser("bill_end_validation", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const input = { name: "Internet", amountMinor: 1500, frequency: "monthly" as const, nextDueDate: "2099-01-31", accountId: account.id, categoryId: category.id };

    expect(() => store.createBill(user.id, { ...input, endDate: "2099-02-30" })).toThrow(/date/i);
    expect(() => store.createBill(user.id, { ...input, endDate: "2099-01-30" })).toThrow(/end date/i);
  });

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

  it("migrates legacy transaction rows with null debt links and does not infer a matching debt", () => {
    const user = store.registerUser("legacy_debt_activity", "hash");
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    const transaction = store.createTransaction(user.id, {
      kind: "expense", amountMinor: 5_000, accountId: account.id, categoryId: food.id,
      description: "Owed by Mina", date: "2026-10-10",
    });
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 5_000 });

    database.exec("DROP INDEX IF EXISTS transactions_one_debt_advance");
    const columns = database.pragma("table_info(transactions)") as { name: string }[];
    if (columns.some((column) => column.name === "debt_id")) database.exec("ALTER TABLE transactions DROP COLUMN debt_id");
    store.migrate();

    const migratedColumns = database.pragma("table_info(transactions)") as { name: string }[];
    expect(migratedColumns.some((column) => column.name === "debt_id")).toBe(true);
    expect(database.prepare("SELECT debt_id FROM transactions WHERE id=?").get(transaction.id)).toEqual({ debt_id: null });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ activity: [] });

    const linked = store.recordDebtAdvance(user.id,
      { direction: "owed_to_you", counterparty: "Rina", amountMinor: 1_000 },
      { kind: "expense", amountMinor: 1_000, accountId: account.id, categoryId: food.id, description: "Lunch", date: "2026-10-11" });
    database.prepare("DELETE FROM debts WHERE id=? AND user_id=?").run(linked.debt.id, user.id);
    expect(database.prepare("SELECT debt_id FROM transactions WHERE id=?").get(linked.transaction.id)).toEqual({ debt_id: null });
  });

  it("reclassifies only income linked to a surviving same-owner debt owed to you", () => {
    const alice = store.registerUser("legacy_repayment_owner", "hash-a");
    const bob = store.registerUser("legacy_repayment_other", "hash-b");
    const account = store.createAccount(alice.id, { name: "Wallet", type: "cash", openingMinor: 10_000 });
    const income = store.listCategories(alice.id).find((category) => category.type === "income")!;
    const expense = store.listCategories(alice.id).find((category) => category.type === "expense")!;
    const { debt: owedToAlice, transaction: advance } = store.recordDebtAdvance(alice.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 5_000 },
      { kind: "expense", amountMinor: 5_000, accountId: account.id, categoryId: expense.id, description: "Advance", date: "2026-10-11", time: "09:00" });
    const received = store.createTransaction(alice.id, {
      kind: "income", amountMinor: 2_000, accountId: account.id, categoryId: income.id,
      description: "Mina paid me", date: "2026-10-11", time: "09:00", source: "assistant",
    });
    database.prepare("UPDATE transactions SET debt_id=?,undo_until='2099-01-01T00:00:00.000Z',created_at='2026-10-11T09:00:00.000Z' WHERE id=?")
      .run(owedToAlice.id, received.id);
    database.prepare("UPDATE transactions SET created_at='2026-10-11T09:00:00.000Z' WHERE id=?").run(advance.id);
    store.updateDebt(alice.id, owedToAlice.id, { amountMinor: 3_000 });

    const settledDebt = store.createDebt(alice.id, { direction: "owed_to_you", counterparty: "Rina", amountMinor: 1_000 });
    store.updateDebt(alice.id, settledDebt.id, { status: "settled" });
    const settledPayment = store.createTransaction(alice.id, {
      kind: "income", amountMinor: 1_000, accountId: account.id, categoryId: income.id,
      description: "Rina paid me", date: "2026-10-12", source: "assistant",
    });
    database.prepare("UPDATE transactions SET debt_id=? WHERE id=?").run(settledDebt.id, settledPayment.id);

    const borrowed = store.recordDebtAdvance(alice.id,
      { direction: "you_owe", counterparty: "Sam", amountMinor: 3_000 },
      { kind: "income", amountMinor: 3_000, accountId: account.id, categoryId: income.id, description: "Borrowed from Sam", date: "2026-10-12" });
    const unlinked = store.createTransaction(alice.id, {
      kind: "income", amountMinor: 500, accountId: account.id, categoryId: income.id,
      description: "Mina paid me back", date: "2026-10-12",
    });
    const bobsDebt = store.createDebt(bob.id, { direction: "owed_to_you", counterparty: "Alice", amountMinor: 700 });
    const crossOwner = store.createTransaction(alice.id, {
      kind: "income", amountMinor: 700, accountId: account.id, categoryId: income.id,
      description: "Other owner's debt", date: "2026-10-12",
    });
    database.prepare("UPDATE transactions SET debt_id=? WHERE id=?").run(bobsDebt.id, crossOwner.id);
    const conversationId = store.createConversation(alice.id, "Repayment");
    store.addMessage(alice.id, conversationId, "assistant", "Mina paid you back.", received.id);
    const beforeBalance = store.listAccounts(alice.id)[0].balanceMinor;
    const rowIds = database.prepare("SELECT id,rowid FROM transactions ORDER BY rowid").all() as { id: string; rowid: number }[];

    restoreLegacyTransactionSchema(database);
    store.migrate();

    expect(store.getTransaction(alice.id, received.id)).toMatchObject({ kind: "debt_repayment", categoryId: undefined, categoryName: null, undoUntil: null });
    expect(store.getTransaction(alice.id, settledPayment.id)).toMatchObject({ kind: "debt_repayment", categoryId: undefined, categoryName: null, undoUntil: null });
    expect(store.getTransaction(alice.id, borrowed.transaction.id)).toMatchObject({ kind: "income", categoryId: income.id });
    expect(store.getTransaction(alice.id, unlinked.id)).toMatchObject({ kind: "income", categoryId: income.id });
    expect(store.getTransaction(alice.id, crossOwner.id)).toMatchObject({ kind: "income", categoryId: income.id });
    expect(store.listDebts(alice.id).find((debt) => debt.id === owedToAlice.id)?.activity.map((entry) => [entry.transactionId, entry.kind]))
      .toEqual([[advance.id, "expense"], [received.id, "debt_repayment"]]);
    expect(store.getConversation(alice.id, conversationId)?.messages[0]?.transaction).toMatchObject({
      id: received.id, kind: "debt_repayment", categoryName: null,
    });
    expect(store.listAccounts(alice.id)[0].balanceMinor).toBe(beforeBalance);
    expect(database.prepare("SELECT id,rowid FROM transactions ORDER BY rowid").all()).toEqual(rowIds);
    expect(database.pragma("foreign_key_check")).toEqual([]);

    store.migrate();
    expect(store.getTransaction(alice.id, received.id)?.kind).toBe("debt_repayment");
    expect(database.prepare("SELECT id,rowid FROM transactions ORDER BY rowid").all()).toEqual(rowIds);
  });

  it("rolls back a failed kind migration and restores foreign-key enforcement", () => {
    const owner = store.registerUser("legacy_repayment_rollback", "hash");
    const account = store.createAccount(owner.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const income = store.listCategories(owner.id).find((category) => category.type === "income")!;
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    const transaction = store.createTransaction(owner.id, {
      kind: "income", amountMinor: 1_000, accountId: account.id, categoryId: income.id,
      description: "Mina paid me", date: "2026-10-11",
    });
    database.prepare("UPDATE transactions SET debt_id=? WHERE id=?").run(debt.id, transaction.id);
    const unlinkedIncome = store.createTransaction(owner.id, {
      kind: "income", amountMinor: 500, accountId: account.id, categoryId: income.id,
      description: "Unlinked income", date: "2026-10-11",
    });
    restoreLegacyTransactionSchema(database);
    database.pragma("foreign_keys = OFF");
    database.prepare("UPDATE transactions SET category_id='missing-category' WHERE id=?").run(unlinkedIncome.id);
    database.pragma("foreign_keys = ON");

    expect(() => store.migrate()).toThrow();

    const legacySchema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { sql: string };
    expect(legacySchema.sql).not.toContain("debt_repayment");
    expect(database.prepare("SELECT kind,category_id,debt_id FROM transactions WHERE id=?").get(unlinkedIncome.id)).toEqual({
      kind: "income", category_id: "missing-category", debt_id: null,
    });
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

    database.prepare("UPDATE transactions SET category_id=? WHERE id=?").run(income.id, unlinkedIncome.id);
    store.migrate();
    expect(store.getTransaction(owner.id, transaction.id)).toMatchObject({ kind: "debt_repayment", categoryId: undefined });
  });
});
