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

describe("personal debt register", () => {
  it("migrates existing debts to principal and normalized counterparties idempotently", () => {
    const owner = store.registerUser("debt_foundation_migration", "hash");
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec(`DROP TABLE debt_payments; DROP TABLE counterparties;
      CREATE TABLE debts_old (
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK(direction IN ('owed_to_you','you_owe')),counterparty TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK(amount_minor>0),note TEXT NOT NULL DEFAULT '',due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','settled')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      INSERT INTO debts_old SELECT id,user_id,direction,counterparty,amount_minor,note,due_date,status,created_at,updated_at FROM debts;
      DROP TABLE debts; ALTER TABLE debts_old RENAME TO debts;`);
    const account = store.createAccount(owner.id, { name: "Legacy cash", type: "cash", openingMinor: 0 });
    const income = store.listCategories(owner.id).find((category) => category.type === "income")!;
    const legacyTransactions = [
      { id: "legacy-transaction-income", kind: "income", amount: 125, account: account.id, category: income.id },
      { id: "legacy-transaction-expense", kind: "expense", amount: 75, account: account.id, category: store.listCategories(owner.id).find((category) => category.type === "expense")!.id },
    ];
    for (const transaction of legacyTransactions) {
      database.prepare(`INSERT INTO transactions(id,user_id,kind,amount_minor,account_id,category_id,description,date,created_at)
        VALUES(?,?,?,?,?,?,?,'2026-10-01','2026-10-01')`).run(transaction.id, owner.id, transaction.kind, transaction.amount, transaction.account, transaction.category, "Legacy row");
    }
    const oldIndexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions' AND name LIKE 'transactions_%'").all() as { name: string }[];
    database.pragma("foreign_keys=OFF");
    database.exec(`CREATE TABLE transactions_old (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
      account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
      destination_account_id TEXT REFERENCES financial_accounts(id) ON DELETE RESTRICT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      debt_id TEXT REFERENCES debts(id) ON DELETE SET NULL,description TEXT NOT NULL,date TEXT NOT NULL,time TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','assistant')),undo_until TEXT,created_at TEXT NOT NULL,
      CHECK((kind='transfer' AND destination_account_id IS NOT NULL AND category_id IS NULL) OR (kind!='transfer' AND destination_account_id IS NULL AND category_id IS NOT NULL)),
      CHECK(destination_account_id IS NULL OR destination_account_id!=account_id));
      INSERT INTO transactions_old SELECT * FROM transactions;
      DROP TABLE transactions; ALTER TABLE transactions_old RENAME TO transactions;`);
    database.pragma("foreign_keys=ON");
    const rowsBeforeMigration = database.prepare("SELECT id,amount_minor,kind,account_id FROM transactions ORDER BY id").all();
    const oldTransactionIndexes = oldIndexes.map(({ name }) => name);
    database.prepare(`INSERT INTO debts(id,user_id,direction,counterparty,amount_minor,note,due_date,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'',NULL,'open','2026-10-01','2026-10-01')`).run("legacy-one", owner.id, "owed_to_you", "AÑa-Lu", 800);
    database.prepare(`INSERT INTO debts(id,user_id,direction,counterparty,amount_minor,note,due_date,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'',NULL,'settled','2026-10-02','2026-10-02')`).run("legacy-two", owner.id, "you_owe", "Aña-lu", 500);
    database.prepare(`INSERT INTO debts(id,user_id,direction,counterparty,amount_minor,note,due_date,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'',NULL,'open','2026-10-03','2026-10-03')`).run("legacy-three", owner.id, "you_owe", "Ana Lu", 300);

    store = createStore(database);
    store.migrate();
    expect(database.prepare("SELECT id,amount_minor,kind,account_id FROM transactions ORDER BY id").all()).toEqual(rowsBeforeMigration);
    const newTransactionIndexes = (database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions'").all() as { name: string }[]).map(({ name }) => name);
    expect(newTransactionIndexes).toEqual(expect.arrayContaining(oldTransactionIndexes));
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.prepare("SELECT id,principal_minor,counterparty_id FROM debts ORDER BY id").all()).toMatchObject([
      { id: "legacy-one", principal_minor: 800 }, { id: "legacy-three", principal_minor: 300 }, { id: "legacy-two", principal_minor: 500 },
    ]);
    const links = database.prepare("SELECT id,counterparty_id FROM debts ORDER BY id").all() as { id: string; counterparty_id: string }[];
    expect(links[0].counterparty_id).toBe(links[2].counterparty_id);
    expect(links[1].counterparty_id).not.toBe(links[0].counterparty_id);
    const counterpartyCount = database.prepare("SELECT COUNT(*) AS count FROM counterparties").get() as { count: number };
    store.migrate();
    expect(database.prepare("SELECT COUNT(*) AS count FROM counterparties").get()).toEqual(counterpartyCount);
    expect(database.prepare("SELECT COUNT(*) AS count FROM debt_payments").get()).toEqual({ count: 0 });
  });

  it("creates debts in either direction with optional due dates and notes", () => {
    const alice = store.registerUser("debt_owner", "hash-a");
    const bob = store.registerUser("debt_other", "hash-b");
    const cash = store.createAccount(alice.id, { name: "Cash", type: "cash", openingMinor: 200_000 });
    const food = store.listCategories(alice.id).find((category) => category.name === "Food")!;
    store.createTransaction(alice.id, { kind: "expense", amountMinor: 2_500, accountId: cash.id, categoryId: food.id, description: "Lunch", date: "2026-10-10" });
    const dashboardBeforeDebt = store.getDashboard(alice.id, "2026-10-01", "2026-10-31");

    const owedToAlice = store.createDebt(alice.id, {
      direction: "owed_to_you",
      counterparty: "Mina",
      amountMinor: 125_050,
      dueDate: "2026-11-15",
      note: "Shared trip costs",
    });
    const aliceOwes = store.createDebt(alice.id, {
      direction: "you_owe",
      counterparty: "Landlord",
      amountMinor: 50_000,
    });

    expect(owedToAlice).toMatchObject({
      direction: "owed_to_you",
      counterparty: "Mina",
      amountMinor: 125_050,
      dueDate: "2026-11-15",
      note: "Shared trip costs",
      status: "open",
    });
    expect(aliceOwes).toMatchObject({
      direction: "you_owe",
      counterparty: "Landlord",
      amountMinor: 50_000,
      dueDate: null,
      note: "",
      status: "open",
    });
    expect(store.listDebts(alice.id)).toHaveLength(2);
    expect(store.listDebts(bob.id)).toEqual([]);
    expect(store.getDashboard(alice.id, "2026-10-01", "2026-10-31")).toEqual(dashboardBeforeDebt);
  });

  it("allows only the owner to edit, settle, reopen, or delete a debt", () => {
    const alice = store.registerUser("debt_owner2", "hash-a");
    const bob = store.registerUser("debt_other2", "hash-b");
    const debt = store.createDebt(alice.id, {
      direction: "you_owe",
      counterparty: "Sam",
      amountMinor: 30_000,
    });

    expect(() => store.updateDebt(bob.id, debt.id, { amountMinor: 1 })).toThrow(/not found/i);
    expect(() => store.deleteDebt(bob.id, debt.id)).toThrow(/not found/i);

    const updated = store.updateDebt(alice.id, debt.id, {
      counterparty: "Sam R.",
      amountMinor: 28_000,
      note: "Current amount after a cash payment",
      dueDate: "2026-12-01",
    });
    expect(updated).toMatchObject({ counterparty: "Sam R.", amountMinor: 28_000, note: "Current amount after a cash payment", dueDate: "2026-12-01", status: "open" });

    const settled = store.updateDebt(alice.id, debt.id, { status: "settled" });
    expect(settled.status).toBe("settled");
    expect(store.listDebts(alice.id)).toMatchObject([{ id: debt.id, status: "settled" }]);

    expect(() => store.updateDebt(bob.id, debt.id, { status: "open" })).toThrow(/not found/i);
    expect(store.updateDebt(alice.id, debt.id, { status: "open" }).status).toBe("open");
    store.deleteDebt(alice.id, debt.id);
    expect(store.listDebts(alice.id)).toEqual([]);
  });

  it("deletes a user's private debts with their account", () => {
    store.registerUser("debt_admin", "hash-admin");
    const owner = store.registerUser("debt_deleted_owner", "hash-owner");
    store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 5_000 });

    store.deleteAccountOwner(owner.id);

    expect(store.listDebts(owner.id)).toEqual([]);
  });

  it("rejects invalid debt directions, amounts, counterparties, notes, and due dates", () => {
    const user = store.registerUser("debt_validation", "hash");
    const valid = { direction: "owed_to_you" as const, counterparty: "Mina", amountMinor: 1 };

    expect(() => store.createDebt(user.id, { ...valid, direction: "sideways" as never })).toThrow(/direction/i);
    expect(() => store.createDebt(user.id, { ...valid, amountMinor: 0 })).toThrow(/amount/i);
    expect(() => store.createDebt(user.id, { ...valid, amountMinor: 1.5 })).toThrow(/amount/i);
    expect(() => store.createDebt(user.id, { ...valid, counterparty: "   " })).toThrow(/counterparty/i);
    expect(() => store.createDebt(user.id, { ...valid, dueDate: "2026-02-30" })).toThrow(/date/i);
    expect(() => store.createDebt(user.id, { ...valid, note: "x".repeat(501) })).toThrow(/note/i);

    const debt = store.createDebt(user.id, valid);
    expect(() => store.updateDebt(user.id, debt.id, { status: "paid" as never })).toThrow(/status/i);
    expect(() => store.updateDebt(user.id, debt.id, { dueDate: "not-a-date" })).toThrow(/date/i);
  });

  it("records an owed-to-you debt with its expense as one non-undoable advance", () => {
    const owner = store.registerUser("debt_advance_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 50_000 });
    const category = store.listCategories(owner.id).find((item) => item.name === "Other" && item.type === "expense")!;

    const result = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 5_000 },
      { kind: "expense", amountMinor: 5_000, accountId: account.id, categoryId: category.id, description: "Owed by Mina", date: "2026-10-11", source: "assistant" });

    expect(result.debt).toMatchObject({ direction: "owed_to_you", counterparty: "Mina", amountMinor: 5_000, status: "open" });
    expect(result.transaction).toMatchObject({ kind: "expense", amountMinor: 5_000, accountName: "Cash", categoryName: "Other", undoUntil: null });
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(45_000);
  });

  it("records money borrowed from a person as linked income", () => {
    const owner = store.registerUser("debt_borrowed_income", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 20_000 });
    const income = store.listCategories(owner.id).find((item) => item.name === "Other income")!;

    const result = store.recordDebtAdvance(owner.id,
      { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 5_000, note: "Food" },
      { kind: "income", amountMinor: 5_000, accountId: account.id, categoryId: income.id, description: "Borrowed from Ate Liyah for food", date: "2026-10-11", source: "assistant" });

    expect(result).toMatchObject({
      debt: { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 5_000, note: "Food" },
      transaction: { kind: "income", amountMinor: 5_000, description: "Borrowed from Ate Liyah for food", undoUntil: null },
    });
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(25_000);
    expect(result.debt.activity).toMatchObject([{ kind: "income", amountMinor: 5_000 }]);
  });

  it("records a received principal payment outside income and spending", () => {
    const owner = store.registerUser("debt_principal_inflow", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 20_000 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000 });

    const partial = store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 4_000, accountId: account.id, description: "Mina paid me", date: "2026-10-11", time: "09:00",
    });
    const partialDashboard = store.getDashboard(owner.id, "2026-10-01", "2026-10-31");

    expect(partial.transaction).toMatchObject({ kind: "debt_repayment", categoryId: undefined, categoryName: null, undoUntil: null });
    expect(partial.debt).toMatchObject({ amountMinor: 6_000, status: "open" });
    expect(store.listDebtPayments(owner.id, debt.id).find((item) => item.transactionId === partial.transaction.id))
      .toMatchObject({ kind: "payment", amountMinor: 4_000, deltaMinor: -4_000, transactionId: partial.transaction.id });
    expect(partialDashboard).toMatchObject({ incomeMinor: 0, spendingMinor: 0, debtRepaymentMinor: 4_000, netCashFlowMinor: 4_000 });
    expect(partialDashboard.accounts).toMatchObject([{ balanceMinor: 24_000 }]);

    const settled = store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 6_000, accountId: account.id, description: "Mina paid the rest", date: "2026-10-11", time: "10:00",
    });

    expect(settled.debt).toMatchObject({ amountMinor: 6_000, status: "settled" });
    expect(settled.transaction.kind).toBe("debt_repayment");
    expect(store.getDashboard(owner.id, "2026-10-01", "2026-10-31")).toMatchObject({
      incomeMinor: 0, spendingMinor: 0, debtRepaymentMinor: 10_000, netCashFlowMinor: 10_000,
    });
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(30_000);
  });

  it("records outgoing debt payments as linked expenses and settles the debt atomically", () => {
    const owner = store.registerUser("debt_outgoing_payment", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 20_000 });
    const expense = store.listCategories(owner.id).find((item) => item.name === "Food")!;
    const debt = store.createDebt(owner.id, { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 10_000 });
    const paymentInput = {
      kind: "expense" as const, amountMinor: 4_000, accountId: account.id, categoryId: expense.id,
      description: "Paid Ate Liyah", date: "2026-10-11", time: "09:00", source: "assistant" as const,
    };

    const partial = store.recordDebtRepayment(owner.id, debt.id, paymentInput);
    const settled = store.recordDebtRepayment(owner.id, debt.id, { ...paymentInput, amountMinor: 6_000, time: "10:00" });

    expect(partial.debt).toMatchObject({ amountMinor: 6_000, status: "open" });
    expect(partial.transaction).toMatchObject({ kind: "expense", amountMinor: 4_000, undoUntil: null });
    expect(store.listDebtPayments(owner.id, debt.id).find((item) => item.transactionId === partial.transaction.id))
      .toMatchObject({ kind: "payment", amountMinor: 4_000, deltaMinor: -4_000, transactionId: partial.transaction.id });
    expect(settled.debt).toMatchObject({ amountMinor: 6_000, status: "settled" });
    expect(settled.transaction).toMatchObject({ kind: "expense", amountMinor: 6_000, undoUntil: null });
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(10_000);
    expect(store.listDebts(owner.id)[0].activity.map(({ amountMinor }) => amountMinor)).toEqual([-4_000, -6_000]);
  });

  it("rolls back outgoing repayment when the account or payment amount is invalid", () => {
    const owner = store.registerUser("debt_outgoing_rollback", "hash");
    const other = store.registerUser("debt_outgoing_other", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const otherAccount = store.createAccount(other.id, { name: "Other cash", type: "cash", openingMinor: 0 });
    const expense = store.listCategories(owner.id).find((item) => item.name === "Other")!;
    const debt = store.createDebt(owner.id, { direction: "you_owe", counterparty: "Mina", amountMinor: 5_000 });
    const input = { kind: "expense" as const, amountMinor: 1_000, accountId: account.id, categoryId: expense.id, description: "Paid Mina", date: "2026-10-11" };

    expect(() => store.recordDebtRepayment(owner.id, debt.id, { ...input, accountId: otherAccount.id })).toThrow(/account/i);
    expect(() => store.recordDebtRepayment(owner.id, debt.id, { ...input, amountMinor: 5_001 })).toThrow(/exceed/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 5_000, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(0);
  });

  it("keeps same-time linked activity in insertion order", () => {
    const owner = store.registerUser("debt_same_time_order", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const food = store.listCategories(owner.id).find((item) => item.name === "Food")!;
    const { debt, transaction: advance } = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 2_000 },
      { kind: "expense", amountMinor: 2_000, accountId: account.id, categoryId: food.id, description: "Advance", date: "2026-10-11", time: "09:00" });
    const payment = store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 1_000, accountId: account.id, description: "Repayment", date: "2026-10-11", time: "09:00",
    });
    database.prepare("UPDATE transactions SET id='z-advance',created_at='2026-10-11T09:00:00.000Z' WHERE id=?").run(advance.id);
    database.prepare("UPDATE transactions SET id='a-repayment',created_at='2026-10-11T09:00:00.000Z' WHERE id=?").run(payment.transaction.id);

    expect(store.listDebts(owner.id).find((item) => item.id === debt.id)?.activity.map(({ transactionId }) => transactionId))
      .toEqual(["z-advance", "a-repayment"]);
  });

  it("rolls back an owed-to-you debt when its expense is invalid", () => {
    const owner = store.registerUser("debt_advance_rollback_owner", "hash");
    const other = store.registerUser("debt_advance_rollback_other", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 50_000 });
    const otherAccount = store.createAccount(other.id, { name: "Other cash", type: "cash", openingMinor: 0 });
    const expenseCategory = store.listCategories(owner.id).find((item) => item.name === "Other" && item.type === "expense")!;
    const incomeCategory = store.listCategories(owner.id).find((item) => item.type === "income")!;
    const debt = { direction: "owed_to_you" as const, counterparty: "Mina", amountMinor: 5_000 };
    const expense = { kind: "expense" as const, amountMinor: 5_000, accountId: account.id, categoryId: expenseCategory.id, description: "Owed by Mina", date: "2026-10-11", source: "assistant" as const };

    for (const invalidExpense of [
      { ...expense, accountId: otherAccount.id },
      { ...expense, categoryId: incomeCategory.id },
      { ...expense, amountMinor: 5_001 },
    ]) {
      expect(() => store.recordDebtAdvance(owner.id, debt, invalidExpense)).toThrow();
      expect(store.listDebts(owner.id)).toEqual([]);
      expect(store.listTransactions(owner.id)).toEqual([]);
      expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(50_000);
    }
  });

  it("returns only linked advance and repayment activity in chronological signed order", () => {
    const owner = store.registerUser("debt_activity_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 50_000 });
    const food = store.listCategories(owner.id).find((item) => item.name === "Food")!;
    const { debt } = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000 },
      { kind: "expense", amountMinor: 10_000, accountId: account.id, categoryId: food.id, description: "Lunch advance", date: "2026-10-10", time: "12:00" });

    store.updateDebt(owner.id, debt.id, { amountMinor: 20_000 });
    store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 2_500, accountId: account.id, description: "Mina paid me", date: "2026-10-12", time: "09:30",
    });

    expect(store.listDebts(owner.id).find((item) => item.id === debt.id)).toMatchObject({
      amountMinor: 17_500,
      activity: [
        { date: "2026-10-10", time: "12:00", kind: "expense", amountMinor: -10_000, categoryName: "Food", accountName: "Cash", description: "Lunch advance" },
        { date: "2026-10-12", time: "09:30", kind: "debt_repayment", amountMinor: 2_500, categoryName: null, accountName: "Cash", description: "Mina paid me" },
      ],
    });
  });

  it("blocks linked movement amount, kind, delete, and debt-direction changes while allowing history edits", () => {
    const owner = store.registerUser("linked_debt_guards", "hash");
    const wallet = store.createAccount(owner.id, { name: "Wallet", type: "cash", openingMinor: 50_000 });
    const bank = store.createAccount(owner.id, { name: "Bank", type: "bank", openingMinor: 0 });
    const food = store.listCategories(owner.id).find((item) => item.name === "Food")!;
    const other = store.listCategories(owner.id).find((item) => item.name === "Other")!;
    const income = store.listCategories(owner.id).find((item) => item.type === "income")!;
    const { debt, transaction } = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000 },
      { kind: "expense", amountMinor: 10_000, accountId: wallet.id, categoryId: food.id, description: "Lunch", date: "2026-10-10" });
    const transactionInput = { kind: "expense" as const, amountMinor: 10_000, accountId: wallet.id, categoryId: food.id, description: "Lunch", date: "2026-10-10" };

    expect(() => store.updateTransaction(owner.id, transaction.id, { ...transactionInput, amountMinor: 9_000 })).toThrow(/linked to a debt/i);
    expect(() => store.updateTransaction(owner.id, transaction.id, { ...transactionInput, kind: "income", categoryId: income.id })).toThrow(/linked to a debt/i);
    expect(() => store.deleteTransaction(owner.id, transaction.id)).toThrow(/linked to a debt/i);
    expect(() => store.updateDebt(owner.id, debt.id, { direction: "you_owe" })).toThrow(/linked activity/i);

    store.updateTransaction(owner.id, transaction.id, {
      ...transactionInput, accountId: bank.id, categoryId: other.id, description: "Updated lunch", date: "2026-10-11",
    });
    expect(store.listDebts(owner.id).find((item) => item.id === debt.id)?.activity).toMatchObject([
      { date: "2026-10-11", kind: "expense", amountMinor: -10_000, categoryName: "Other", accountName: "Bank", description: "Updated lunch" },
    ]);
    expect(store.listAccounts(owner.id).reduce((sum, account) => sum + account.balanceMinor, 0)).toBe(40_000);
  });

  it("keeps linked transactions when deleting a debt and clears the relationship", () => {
    const owner = store.registerUser("delete_linked_debt", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 20_000 });
    const category = store.listCategories(owner.id).find((item) => item.name === "Food")!;
    const { debt, transaction } = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 5_000 },
      { kind: "expense", amountMinor: 5_000, accountId: account.id, categoryId: category.id, description: "Lunch", date: "2026-10-10" });

    store.deleteDebt(owner.id, debt.id);

    expect(database.prepare("SELECT debt_id FROM transactions WHERE id=?").get(transaction.id)).toEqual({ debt_id: null });
    expect(store.listTransactions(owner.id)).toMatchObject([{ id: transaction.id, amountMinor: 5_000 }]);
    store.updateTransaction(owner.id, transaction.id, { kind: "expense", amountMinor: 4_000, accountId: account.id, categoryId: category.id, description: "Adjusted after debt removal", date: "2026-10-11" });
    store.deleteTransaction(owner.id, transaction.id);
    expect(store.listTransactions(owner.id)).toEqual([]);
  });

  it("does not let another owner repay a private debt", () => {
    const owner = store.registerUser("debt_payment_private_owner", "hash");
    const other = store.registerUser("debt_payment_private_other", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000 });

    expect(() => store.recordDebtPayment(other.id, debt.id, {
      amountMinor: 2_500, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    })).toThrow(/debt not found/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10_000, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.listTransactions(other.id)).toEqual([]);
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(0);
  });

  it("rolls back a repayment if its cash inflow would overflow account totals", () => {
    const owner = store.registerUser("debt_payment_overflow", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: Number.MAX_SAFE_INTEGER });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1 });

    expect(() => store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 1, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    })).toThrow(/supported exact PHP minor-unit range/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 1, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rolls back debt changes when a repayment is invalid or exceeds the debt", () => {
    const owner = store.registerUser("debt_repayment_owner", "hash");
    const otherOwner = store.registerUser("debt_repayment_other_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const otherAccount = store.createAccount(otherOwner.id, { name: "Other cash", type: "cash", openingMinor: 0 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10000 });
    const transaction = {
      amountMinor: 5000, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    };

    expect(() => store.recordDebtPayment(owner.id, debt.id, { ...transaction, accountId: otherAccount.id })).toThrow(/account/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10000, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);

    expect(() => store.recordDebtPayment(owner.id, debt.id, { ...transaction, amountMinor: 0 })).toThrow(/amount/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10000, status: "open" }]);
    expect(store.listTransactions(owner.id)).toEqual([]);

    expect(() => store.recordDebtPayment(owner.id, debt.id, { ...transaction, amountMinor: 10001 })).toThrow(/exceed/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10000, status: "open" }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
  });

  it("marks a fully repaid debt settled and retains its last positive balance", () => {
    const owner = store.registerUser("debt_fully_repaid_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10000 });

    const payment = store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 10000, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    });

    expect(payment.debt).toMatchObject({ id: debt.id, amountMinor: 10000, status: "settled" });
    expect(payment.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, categoryId: undefined, undoUntil: null });
    expect(store.listDebtPayments(owner.id, debt.id)).toMatchObject([{ kind: "payment", amountMinor: 10000, deltaMinor: -10000, transactionId: payment.transaction.id }]);
    expect(store.debtBalanceFromPayments(owner.id, debt)).toBe(0);
  });

  it("records amount edits as adjustments without a cash transaction", () => {
    const owner = store.registerUser("debt_adjustment_owner", "hash");
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });

    const updated = store.updateDebt(owner.id, debt.id, { amountMinor: 1_400 });

    expect(updated.amountMinor).toBe(1_400);
    expect(store.listDebtPayments(owner.id, debt.id)).toMatchObject([{ kind: "adjustment", amountMinor: 400, deltaMinor: 400, reason: "manual amount edit", transactionId: null }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.debtBalanceFromPayments(owner.id, debt)).toBe(1_400);
  });

  it("sums payment deltas exactly beyond JavaScript safe integers", () => {
    const owner = store.registerUser("debt_exact_payment_sum", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: Number.MAX_SAFE_INTEGER });

    store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: Number.MAX_SAFE_INTEGER, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    });
    store.updateDebt(owner.id, debt.id, { amountMinor: 1, status: "open" });

    expect(store.debtBalanceFromPayments(owner.id, debt)).toBe(-9_007_199_254_740_990);
  });

  it("does not record payment history when an update leaves the amount unchanged", () => {
    const owner = store.registerUser("debt_note_only_update", "hash");
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    const before = database.prepare("SELECT COUNT(*) AS count FROM debt_payments WHERE debt_id=?").get(debt.id) as { count: number };

    store.updateDebt(owner.id, debt.id, { note: "Updated note" });

    expect(database.prepare("SELECT COUNT(*) AS count FROM debt_payments WHERE debt_id=?").get(debt.id)).toEqual(before);
  });

  it("scopes debt payment and counterparty reads to their owner", () => {
    const alice = store.registerUser("debt_payment_owner_a", "hash");
    const bob = store.registerUser("debt_payment_owner_b", "hash");
    const aliceDebt = store.createDebt(alice.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    const bobDebt = store.createDebt(bob.id, { direction: "owed_to_you", counterparty: "Nina", amountMinor: 2_000 });
    store.updateDebt(alice.id, aliceDebt.id, { amountMinor: 1_200, note: "A note" });
    database.prepare(`INSERT INTO debt_payments(id,user_id,debt_id,direction,kind,amount_minor,delta_minor,reason,transaction_id,created_at)
      VALUES('cross-owner-payment',?,?,?,?,?,?,?,NULL,'2026-10-11')`).run(alice.id, bobDebt.id, "owed_to_you", "adjustment", 700, -700, "cross-owner row");

    expect(store.listDebtPayments(alice.id, aliceDebt.id)).toHaveLength(1);
    expect(store.listDebtPayments(alice.id, bobDebt.id)).toEqual([]);
    expect(store.listDebtPayments(bob.id, bobDebt.id)).toEqual([]);
    expect(store.debtBalanceFromPayments(bob.id, bobDebt)).toBe(2_000);
    expect(database.prepare("SELECT name FROM counterparties WHERE user_id=?").all(bob.id)).toEqual([{ name: "Nina" }]);
    expect(database.prepare("SELECT id FROM counterparties WHERE user_id=?").all(alice.id)).toHaveLength(1);
  });

  it("does not create payment history for debt advances", () => {
    const owner = store.registerUser("debt_advance_no_pay", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 500 });
    const category = store.listCategories(owner.id).find((item) => item.name === "Other")!;
    const countPayments = () => (database.prepare("SELECT COUNT(*) AS count FROM debt_payments WHERE user_id=?").get(owner.id) as { count: number }).count;
    const transactionInput = { kind: "expense" as const, amountMinor: 100, accountId: account.id, categoryId: category.id, description: "Advance", date: "2026-10-11" };

    expect(countPayments()).toBe(0);
    store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 100 });
    expect(countPayments()).toBe(0);
    const advanceDebt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Nina", amountMinor: 100 });
    store.recordDebtAdvanceTransaction(owner.id, advanceDebt.id, transactionInput);
    expect(countPayments()).toBe(0);
    store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Ona", amountMinor: 100 }, transactionInput);
    expect(countPayments()).toBe(0);
  });

  it("records a full you_owe repayment as one linked expense payment", () => {
    const owner = store.registerUser("you_owe_full_repayment_history", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const category = store.listCategories(owner.id).find((item) => item.name === "Other")!;
    const debt = store.createDebt(owner.id, { direction: "you_owe", counterparty: "Mina", amountMinor: 1_000 });

    const repayment = store.recordDebtRepayment(owner.id, debt.id, {
      kind: "expense", amountMinor: 1_000, accountId: account.id, categoryId: category.id,
      description: "Paid Mina", date: "2026-10-11",
    });

    expect(repayment.debt.status).toBe("settled");
    expect(store.listDebtPayments(owner.id, debt.id)).toMatchObject([
      { kind: "payment", amountMinor: 1_000, deltaMinor: -1_000 },
    ]);
    expect(store.listDebtPayments(owner.id, debt.id)).toHaveLength(1);
    expect(repayment.transaction).toMatchObject({ kind: "expense", debtId: debt.id });
  });

  it("rolls back a repayment payment row when a later ledger validation fails", () => {
    const owner = store.registerUser("debt_payment_late_failure", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: Number.MAX_SAFE_INTEGER - 1 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1 });
    database.prepare(`CREATE TRIGGER fail_payment_validation AFTER INSERT ON debt_payments BEGIN
      UPDATE financial_accounts SET balance_adjustment_minor_exact='1' WHERE id='${account.id}';
    END`).run();

    expect(() => store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 1, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    })).toThrow(/supported exact PHP minor-unit range/i);
    expect(store.listDebtPayments(owner.id, debt.id)).toEqual([]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 1, status: "open" }]);
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it("cascades payment rows when deleting a debt and preserves its linked transaction", () => {
    const owner = store.registerUser("delete_payment_debt_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    const payment = store.recordDebtPayment(owner.id, debt.id, {
      amountMinor: 250, accountId: account.id, description: "Mina paid me", date: "2026-10-11",
    });

    store.deleteDebt(owner.id, debt.id);

    expect(database.prepare("SELECT id FROM debt_payments WHERE debt_id=?").all(debt.id)).toEqual([]);
    expect(store.getTransaction(owner.id, payment.transaction.id)).toMatchObject({ id: payment.transaction.id, debtId: undefined });
  });
});
