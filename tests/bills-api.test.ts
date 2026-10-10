import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { HttpError } from "../src/lib/api";
import { GET, POST } from "../src/app/api/bills/route";
import { PATCH } from "../src/app/api/bills/[id]/route";
import { POST as archive } from "../src/app/api/bills/[id]/archive/route";

const mocks = vi.hoisted(() => ({ getStore: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), requireUser: mocks.requireUser }));

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let user: ReturnType<ReturnType<typeof createStore>["registerUser"]>;
let accountId: string;
let categoryId: string;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, url: string, body?: unknown, origin = "https://tally.test") => new Request(url, {
  method, headers: { origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T08:00:00.000Z"));
  database = new Database(":memory:"); store = createStore(database); store.migrate();
  user = store.registerUser("bills_api_user", "hash");
  accountId = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10000 }).id;
  categoryId = store.listCategories(user.id).find((category) => category.name === "Utilities")!.id;
  mocks.getStore.mockReturnValue(store); mocks.requireUser.mockResolvedValue(user);
});
afterEach(() => { database.close(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("Bills API", () => {
  it("accepts and validates built-in bill icons", async () => {
    const created = await POST(request("POST", "https://tally.test/api/bills", { name: "Internet", amount: "15.00", frequency: "monthly", nextDueDate: "2099-01-01", accountId, categoryId, icon: "wifi" }));
    expect(created.status).toBe(201);
    const { bill } = await created.json();
    expect(bill.icon).toBe("wifi");

    const updated = await PATCH(request("PATCH", `https://tally.test/api/bills/${bill.id}`, { icon: "music" }), context(bill.id));
    expect((await updated.json()).bill.icon).toBe("music");
    const invalid = await POST(request("POST", "https://tally.test/api/bills", { name: "Bad icon", amount: "15.00", frequency: "monthly", nextDueDate: "2099-01-01", accountId, categoryId, icon: "custom" }));
    expect(invalid.status).toBe(400);
  });

  it("requires a signed-in owner for reads and writes", async () => {
    mocks.requireUser.mockRejectedValueOnce(new HttpError(401, "Sign in to continue."));
    expect((await GET()).status).toBe(401);
    const created = await POST(request("POST", "https://tally.test/api/bills", { name: "Rent", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", accountId, categoryId }, "https://evil.test"));
    expect(created.status).toBe(403);
  });

  it("creates bills, immediately posts a due-today expense, and edits bill defaults independently", async () => {
    const created = await POST(request("POST", "https://tally.test/api/bills", { name: "Internet", amount: "25.00", frequency: "monthly", nextDueDate: "2026-10-09", accountId, categoryId }));
    expect(created.status).toBe(201);
    const { bill } = await created.json();
    expect(bill).toMatchObject({ name: "Internet", amountMinor: 2500, nextDueDate: "2026-11-09" });
    expect(store.listTransactions(user.id, { start: "2026-10-09", end: "2026-10-09" }, 10)[0]).toMatchObject({ kind: "expense", amountMinor: 2500, description: "Internet", date: "2026-10-09" });
    const updated = await PATCH(request("PATCH", "https://tally.test/api/bills/" + bill.id, { amount: "30.00" }), context(bill.id));
    expect(updated.status).toBe(200);
    expect(store.listBills(user.id)[0].amountMinor).toBe(3000);
    expect(store.listTransactions(user.id, { start: "2026-10-09", end: "2026-10-09" }, 10)[0].amountMinor).toBe(2500);
    expect((await archive(request("POST", "https://tally.test/api/bills/" + bill.id + "/archive"), context(bill.id))).status).toBe(200);
  });

  it("returns committed due-today POST and PATCH saves with a posting warning after a real overflow failure", async () => {
    store.updateAccount(user.id, accountId, { openingMinor: Number.MAX_SAFE_INTEGER });
    store.createTransaction(user.id, { kind: "expense", amountMinor: Number.MAX_SAFE_INTEGER, accountId, categoryId, description: "At exact limit", date: "2026-10-09" });

    const created = await POST(request("POST", "https://tally.test/api/bills", { name: "Power", amount: "0.01", frequency: "monthly", nextDueDate: "2026-10-09", accountId, categoryId }));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      bill: { name: "Power", amountMinor: 1, nextDueDate: "2026-10-09" },
      postingWarning: expect.stringContaining("will retry automatically"),
    });

    const updated = await PATCH(request("PATCH", `https://tally.test/api/bills/${createdBody.bill.id}`, { name: "Electricity" }), context(createdBody.bill.id));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      bill: { name: "Electricity", nextDueDate: "2026-10-09" },
      postingWarning: expect.stringContaining("will retry automatically"),
    });
    expect(store.listBills(user.id)).toMatchObject([{ name: "Electricity", nextDueDate: "2026-10-09" }]);
    expect(store.listTransactions(user.id, undefined, 10, { kind: "expense" })).toHaveLength(1);
  });

  it("returns a committed due-today POST with a warning after a processor-level database error", async () => {
    vi.spyOn(store, "processDueBills").mockImplementation(() => { throw new Error("database is locked"); });
    const response = await POST(request("POST", "https://tally.test/api/bills", { name: "Water", amount: "1.00", frequency: "monthly", nextDueDate: "2026-10-09", accountId, categoryId }));
    const result = await response.json();
    expect(response.status).toBe(201);
    expect(result).toMatchObject({ bill: { name: "Water", nextDueDate: "2026-10-09" }, postingWarning: expect.stringContaining("will retry automatically") });
    expect(store.listBills(user.id)).toMatchObject([{ name: "Water", nextDueDate: "2026-10-09" }]);
  });

  it("does not fail a bill save when another owner's due expense overflows", async () => {
    const other = store.registerUser("bills_api_blocked", "hash");
    const otherAccount = store.createAccount(other.id, { name: "Full", type: "cash", openingMinor: Number.MAX_SAFE_INTEGER });
    const otherCategory = store.listCategories(other.id).find((entry) => entry.name === "Utilities")!;
    store.createTransaction(other.id, { kind: "expense", amountMinor: Number.MAX_SAFE_INTEGER, accountId: otherAccount.id, categoryId: otherCategory.id, description: "At exact limit", date: "2026-10-09" });
    const blocked = store.createBill(other.id, { name: "Overflow", amountMinor: 1, frequency: "weekly", nextDueDate: "2026-10-09", accountId: otherAccount.id, categoryId: otherCategory.id });
    database.prepare("UPDATE bills SET next_due_date='2026-10-08' WHERE id=?").run(blocked.id);

    const response = await POST(request("POST", "https://tally.test/api/bills", { name: "Water", amount: "1.00", frequency: "weekly", nextDueDate: "2026-10-09", accountId, categoryId }));
    const result = await response.json();
    expect(response.status).toBe(201);
    expect(result).toMatchObject({ bill: { name: "Water", nextDueDate: "2026-10-16" } });
    expect(result.postingWarning).toBeUndefined();
    expect(database.prepare("SELECT next_due_date FROM bills WHERE id=?").get(blocked.id)).toEqual({ next_due_date: "2026-10-08" });
  });

  it("does not warn about posting when the expense succeeded but the bill list refresh fails", async () => {
    const refresh = vi.spyOn(store, "listBills").mockImplementation(() => { throw new Error("temporary read failure"); });
    const response = await POST(request("POST", "https://tally.test/api/bills", { name: "Water", amount: "1.00", frequency: "monthly", nextDueDate: "2026-10-09", accountId, categoryId }));
    const result = await response.json();
    expect(response.status).toBe(201);
    expect(result).toMatchObject({ bill: { name: "Water", nextDueDate: "2026-10-09" } });
    expect(result.postingWarning).toBeUndefined();
    refresh.mockRestore();
    expect(store.listBills(user.id)[0].nextDueDate).toBe("2026-11-09");
    expect(store.listTransactions(user.id, { start: "2026-10-09", end: "2026-10-09" }, 10, { kind: "expense" })).toMatchObject([{ description: "Water", date: "2026-10-09" }]);
  });

  it("rejects another owner's account and income categories and invalid money or dates", async () => {
    const other = store.registerUser("bills_api_other", "hash");
    const otherAccount = store.createAccount(other.id, { name: "Other", type: "cash", openingMinor: 0 });
    const otherCategory = store.listCategories(other.id).find((category) => category.type === "expense")!;
    const income = store.listCategories(user.id).find((category) => category.type === "income")!;
    for (const body of [
      { name: "Bad", amount: "0", frequency: "weekly", nextDueDate: "2026-10-10", accountId, categoryId },
      { name: "Bad", amount: "1", frequency: "weekly", nextDueDate: "2026-02-30", accountId, categoryId },
      { name: "Bad", amount: "1", frequency: "weekly", nextDueDate: "2026-10-10", accountId: otherAccount.id, categoryId },
      { name: "Bad", amount: "1", frequency: "weekly", nextDueDate: "2026-10-10", accountId, categoryId: otherCategory.id },
      { name: "Bad", amount: "1", frequency: "weekly", nextDueDate: "2026-10-10", accountId, categoryId: income.id },
    ]) expect((await POST(request("POST", "https://tally.test/api/bills", body))).status).toBe(400);
  });
});
