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
});
