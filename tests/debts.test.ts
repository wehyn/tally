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
    const income = store.listCategories(owner.id).find((item) => item.name === "Other income")!;
    const { debt, transaction: advance } = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 2_000 },
      { kind: "expense", amountMinor: 2_000, accountId: account.id, categoryId: food.id, description: "Advance", date: "2026-10-11", time: "09:00" });
    const payment = store.recordDebtPayment(owner.id, debt.id, {
      kind: "income", amountMinor: 1_000, accountId: account.id, categoryId: income.id,
      description: "Repayment", date: "2026-10-11", time: "09:00",
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
    const otherIncome = store.listCategories(owner.id).find((item) => item.name === "Other income")!;
    const { debt } = store.recordDebtAdvance(owner.id,
      { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000 },
      { kind: "expense", amountMinor: 10_000, accountId: account.id, categoryId: food.id, description: "Lunch advance", date: "2026-10-10", time: "12:00" });

    store.updateDebt(owner.id, debt.id, { amountMinor: 20_000 });
    store.recordDebtPayment(owner.id, debt.id, {
      kind: "income", amountMinor: 2_500, accountId: account.id, categoryId: otherIncome.id,
      description: "Mina paid me", date: "2026-10-12", time: "09:30",
    });

    expect(store.listDebts(owner.id).find((item) => item.id === debt.id)).toMatchObject({
      amountMinor: 17_500,
      activity: [
        { date: "2026-10-10", time: "12:00", kind: "expense", amountMinor: -10_000, categoryName: "Food", accountName: "Cash", description: "Lunch advance" },
        { date: "2026-10-12", time: "09:30", kind: "income", amountMinor: 2_500, categoryName: "Other income", accountName: "Cash", description: "Mina paid me" },
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
    const income = store.listCategories(owner.id).find((item) => item.type === "income")!;
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000 });

    expect(() => store.recordDebtPayment(other.id, debt.id, {
      kind: "income", amountMinor: 2_500, accountId: account.id, categoryId: income.id,
      description: "Mina paid me", date: "2026-10-11",
    })).toThrow(/debt not found/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10_000, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.listTransactions(other.id)).toEqual([]);
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(0);
  });

  it("rolls back a repayment if the linked income would overflow account totals", () => {
    const owner = store.registerUser("debt_payment_overflow", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: Number.MAX_SAFE_INTEGER });
    const income = store.listCategories(owner.id).find((item) => item.type === "income")!;
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1 });

    expect(() => store.recordDebtPayment(owner.id, debt.id, {
      kind: "income", amountMinor: 1, accountId: account.id, categoryId: income.id,
      description: "Mina paid me", date: "2026-10-11",
    })).toThrow(/supported exact PHP minor-unit range/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 1, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
    expect(store.listAccounts(owner.id)[0].balanceMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rolls back debt changes when repayment income is invalid or exceeds the debt", () => {
    const owner = store.registerUser("debt_repayment_owner", "hash");
    const otherOwner = store.registerUser("debt_repayment_other_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const otherAccount = store.createAccount(otherOwner.id, { name: "Other cash", type: "cash", openingMinor: 0 });
    const incomeCategory = store.listCategories(owner.id).find((category) => category.name === "Other income")!;
    const expenseCategory = store.listCategories(owner.id).find((category) => category.name === "Other")!;
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10000 });
    const transaction = {
      kind: "income" as const, amountMinor: 5000, accountId: account.id, categoryId: incomeCategory.id,
      description: "Mina paid me", date: "2026-10-11", source: "assistant" as const,
    };

    expect(() => store.recordDebtPayment(owner.id, debt.id, { ...transaction, accountId: otherAccount.id })).toThrow(/account/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10000, status: "open", activity: [] }]);
    expect(store.listTransactions(owner.id)).toEqual([]);

    expect(() => store.recordDebtPayment(owner.id, debt.id, { ...transaction, categoryId: expenseCategory.id })).toThrow(/category/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10000, status: "open" }]);
    expect(store.listTransactions(owner.id)).toEqual([]);

    expect(() => store.recordDebtPayment(owner.id, debt.id, { ...transaction, amountMinor: 10001 })).toThrow(/exceed/i);
    expect(store.listDebts(owner.id)).toMatchObject([{ id: debt.id, amountMinor: 10000, status: "open" }]);
    expect(store.listTransactions(owner.id)).toEqual([]);
  });

  it("marks a fully repaid debt settled and retains its last positive balance", () => {
    const owner = store.registerUser("debt_fully_repaid_owner", "hash");
    const account = store.createAccount(owner.id, { name: "Cash", type: "cash", openingMinor: 0 });
    const incomeCategory = store.listCategories(owner.id).find((category) => category.name === "Other income")!;
    const debt = store.createDebt(owner.id, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 10000 });

    const payment = store.recordDebtPayment(owner.id, debt.id, {
      kind: "income", amountMinor: 10000, accountId: account.id, categoryId: incomeCategory.id,
      description: "Mina paid me", date: "2026-10-11", source: "assistant",
    });

    expect(payment.debt).toMatchObject({ id: debt.id, amountMinor: 10000, status: "settled" });
    expect(payment.transaction).toMatchObject({ kind: "income", amountMinor: 10000, undoUntil: null });
  });
});
