import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getStore: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.currentUser }));
vi.mock("@/lib/db", () => ({ getStore: mocks.getStore }));

import { GET, POST } from "../src/app/api/debts/route";
import { DELETE, PATCH } from "../src/app/api/debts/[id]/route";

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let aliceId: string;
let bobId: string;
const alice = { id: "", username: "alice_debts", role: "admin" as const, enabled: true, assistantOptIn: false, createdAt: "2026-01-01T00:00:00.000Z" };
const bob = { id: "", username: "bob_debts", role: "user" as const, enabled: true, assistantOptIn: false, createdAt: "2026-01-02T00:00:00.000Z" };
const origin = "http://localhost:3000";
const postRequest = (body: unknown) => new Request(`${origin}/api/debts`, {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const patchRequest = (id: string, body: unknown) => new Request(`${origin}/api/debts/${id}`, {
  method: "PATCH",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const deleteRequest = (id: string) => new Request(`${origin}/api/debts/${id}`, {
  method: "DELETE",
  headers: { origin },
});

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  aliceId = store.registerUser(alice.username, "hash-a").id;
  bobId = store.registerUser(bob.username, "hash-b").id;
  mocks.getStore.mockReturnValue(store);
  mocks.currentUser.mockResolvedValue({ ...alice, id: aliceId });
});
afterEach(() => {
  database.close();
  vi.clearAllMocks();
});

describe("debt API routes", () => {
  it("requires a signed-in user", async () => {
    mocks.currentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(postRequest({ direction: "owed_to_you", counterparty: "Mina", amount: "25" }))).status).toBe(401);
  });

  it("creates, lists, updates, and deletes only the signed-in user's debts", async () => {
    const createdResponse = await POST(postRequest({
      direction: "owed_to_you",
      counterparty: "Mina",
      amount: "1,250.50",
      dueDate: "2026-11-15",
      note: "Trip costs",
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.debt).toMatchObject({ direction: "owed_to_you", counterparty: "Mina", amountMinor: 125_050, status: "open" });

    const listedResponse = await GET();
    expect((await listedResponse.json()).debts).toMatchObject([{ id: created.debt.id, counterparty: "Mina" }]);

    mocks.currentUser.mockResolvedValue({ ...bob, id: bobId });
    const bobList = await GET();
    expect((await bobList.json()).debts).toEqual([]);
    expect((await PATCH(patchRequest(created.debt.id, { status: "settled" }), { params: Promise.resolve({ id: created.debt.id }) })).status).toBe(404);
    expect((await DELETE(deleteRequest(created.debt.id), { params: Promise.resolve({ id: created.debt.id }) })).status).toBe(404);
    const bobCreatedResponse = await POST(postRequest({ direction: "you_owe", counterparty: "Utility co.", amount: "80.00" }));
    const bobCreated = await bobCreatedResponse.json();
    expect(bobCreatedResponse.status).toBe(201);

    mocks.currentUser.mockResolvedValue({ ...alice, id: aliceId });
    const aliceList = await GET();
    expect((await aliceList.json()).debts.map((debt: { id: string }) => debt.id)).toEqual([created.debt.id]);
    expect((await PATCH(patchRequest(bobCreated.debt.id, { status: "settled" }), { params: Promise.resolve({ id: bobCreated.debt.id }) })).status).toBe(404);
    expect((await DELETE(deleteRequest(bobCreated.debt.id), { params: Promise.resolve({ id: bobCreated.debt.id }) })).status).toBe(404);
    const settledResponse = await PATCH(patchRequest(created.debt.id, { status: "settled" }), { params: Promise.resolve({ id: created.debt.id }) });
    expect((await settledResponse.json()).debt.status).toBe("settled");
    expect((await DELETE(deleteRequest(created.debt.id), { params: Promise.resolve({ id: created.debt.id }) })).status).toBe(200);
  });

  it("rejects invalid request bodies without creating records", async () => {
    const response = await POST(postRequest({ direction: "owed_to_you", counterparty: "Mina", amount: "0" }));
    expect(response.status).toBe(400);
    expect(store.listDebts(aliceId)).toEqual([]);
  });
});
