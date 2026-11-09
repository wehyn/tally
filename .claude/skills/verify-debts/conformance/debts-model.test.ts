// Replays the steps of model/Debts.tla against the real store. Each test names the model rule it checks.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../../../../src/lib/store";

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let ownerId: string;
let accountId: string;
beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  ownerId = store.registerUser("model_owner", "hash").id;
  accountId = store.createAccount(ownerId, { name: "Cash", type: "cash", openingMinor: 100_000 }).id;
});
afterEach(() => database.close());

const cash = () => store.listAccounts(ownerId)[0].balanceMinor;
const pay = (debtId: string, amountMinor: number) =>
  store.recordDebtPayment(ownerId, debtId, { amountMinor, accountId, description: "paid", date: "2026-10-11" });
const repay = (debtId: string, amountMinor: number) => {
  const category = store.listCategories(ownerId).find((c) => c.type === "expense")!;
  return store.recordDebtRepayment(ownerId, debtId, { kind: "expense", amountMinor, accountId, categoryId: category.id, description: "repaid", date: "2026-10-11" });
};
const advance = (debtId: string, amountMinor: number, kind: "expense" | "income") => {
  const category = store.listCategories(ownerId).find((c) => c.type === kind)!;
  return store.recordDebtAdvanceTransaction(ownerId, debtId, { kind, amountMinor, accountId, categoryId: category.id, description: "advance", date: "2026-10-11" });
};
const debtOf = (id: string) => store.listDebts(ownerId).find((d) => d.id === id)!;

describe("model: Pay", () => {
  it("partial then final payment on a debt owed to you: amount shrinks, then settles keeping the last amount; cash rises by exactly the payments", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    pay(debt.id, 400);
    expect(debtOf(debt.id)).toMatchObject({ status: "open", amountMinor: 600 });
    expect(store.debtBalanceFromPayments(ownerId, debt)).toBe(600); // OpenAmountMatchesHistory
    pay(debt.id, 600);
    expect(debtOf(debt.id)).toMatchObject({ status: "settled", amountMinor: 600 });
    expect(cash()).toBe(100_000 + 1_000); // CashMatchesLinkedTransactions
    expect(debtOf(debt.id).activity).toHaveLength(2);
  });
  it("payment on a debt you owe lowers cash by exactly the payment", () => {
    const debt = store.createDebt(ownerId, { direction: "you_owe", counterparty: "Liyah", amountMinor: 1_000 });
    repay(debt.id, 300);
    expect(debtOf(debt.id)).toMatchObject({ status: "open", amountMinor: 700 });
    expect(cash()).toBe(100_000 - 300);
    expect(store.debtBalanceFromPayments(ownerId, debt)).toBe(700);
  });
  it("NoActivityOnSettled: settled debts refuse payments, repayments and advances; nothing is written", () => {
    const owed = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 500 });
    pay(owed.id, 500);
    const owe = store.createDebt(ownerId, { direction: "you_owe", counterparty: "Liyah", amountMinor: 500 });
    repay(owe.id, 500);
    const before = cash();
    expect(() => pay(owed.id, 100)).toThrow();
    expect(() => repay(owe.id, 100)).toThrow();
    expect(() => advance(owed.id, 500, "expense")).toThrow();
    expect(cash()).toBe(before);
    expect(store.listDebtPayments(ownerId, owed.id)).toHaveLength(1);
  });
  it("a payment above the balance is refused atomically", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 500 });
    expect(() => pay(debt.id, 501)).toThrow();
    expect(debtOf(debt.id)).toMatchObject({ status: "open", amountMinor: 500 });
    expect(cash()).toBe(100_000);
    expect(store.listDebtPayments(ownerId, debt.id)).toEqual([]);
  });
});

describe("model: EditAmount / Settle / EditDirection / Delete", () => {
  it("an amount edit on an open debt writes one adjustment and keeps the history equal to the amount", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    store.updateDebt(ownerId, debt.id, { amountMinor: 1_400 });
    expect(store.debtBalanceFromPayments(ownerId, debt)).toBe(1_400);
  });
  it("DirectionStableOnceLinked: direction cannot change once a transaction is linked", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    pay(debt.id, 100);
    expect(() => store.updateDebt(ownerId, debt.id, { direction: "you_owe" })).toThrow(/direction/i);
    const unlinked = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Rey", amountMinor: 1_000 });
    expect(store.updateDebt(ownerId, unlinked.id, { direction: "you_owe" }).direction).toBe("you_owe");
  });
  it("NoLinkAfterDelete: deleting a debt unlinks its transactions and leaves cash alone", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    const { transaction } = pay(debt.id, 400);
    store.deleteDebt(ownerId, debt.id);
    expect(store.listDebts(ownerId)).toEqual([]);
    expect(store.listTransactions(ownerId).find((t) => t.id === transaction.id)?.debtId).toBeUndefined();
    expect(cash()).toBe(100_400);
  });
});

// Reopen and settled edits: fixed in the machine (src/lib/machines/debt.ts, historyAdjustmentForUpdate).
describe("model: Reopen and settled edits", () => {
  it("reopening a payment-settled debt keeps history equal to the amount; the next payment settles it without going negative", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    pay(debt.id, 1_000);
    store.updateDebt(ownerId, debt.id, { status: "open" });
    const reopened = debtOf(debt.id);
    expect(reopened).toMatchObject({ status: "open", amountMinor: 1_000 });
    expect(store.debtBalanceFromPayments(ownerId, reopened)).toBe(1_000); // OpenAmountMatchesHistory
    pay(debt.id, 1_000);
    expect(debtOf(debt.id)).toMatchObject({ status: "settled", amountMinor: 1_000 });
    expect(store.debtBalanceFromPayments(ownerId, debt)).toBe(0); // HistoryNeverNegative
  });
  it("an amount edit on a settled debt writes no adjustment; reopening then matches the reopened amount", () => {
    const debt = store.createDebt(ownerId, { direction: "owed_to_you", counterparty: "Mina", amountMinor: 1_000 });
    pay(debt.id, 1_000);
    store.updateDebt(ownerId, debt.id, { amountMinor: 600 });
    expect(store.listDebtPayments(ownerId, debt.id)).toHaveLength(1);
    expect(store.debtBalanceFromPayments(ownerId, debt)).toBe(0); // HistoryNeverNegative
    store.updateDebt(ownerId, debt.id, { status: "open" });
    expect(store.debtBalanceFromPayments(ownerId, debtOf(debt.id))).toBe(600); // OpenAmountMatchesHistory
  });
});
