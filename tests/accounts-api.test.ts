import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";

const mocks = vi.hoisted(() => ({ getStore: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), requireUser: mocks.requireUser }));

import { POST } from "../src/app/api/accounts/route";
import { PATCH } from "../src/app/api/accounts/[id]/route";

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let user: ReturnType<ReturnType<typeof createStore>["registerUser"]>;
const origin = "https://tally.test";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, url: string, body: unknown) => new Request(url, {
  method,
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  user = store.registerUser("accounts_api_user", "hash");
  mocks.getStore.mockReturnValue(store);
  mocks.requireUser.mockResolvedValue(user);
});
afterEach(() => {
  database.close();
  vi.clearAllMocks();
});

describe("account API routes", () => {
  it("rejects legacy openingBalance on create without creating an account", async () => {
    const response = await POST(request("POST", `${origin}/api/accounts`, {
      name: "Savings", type: "bank", openingBalance: "125.00",
    }));

    expect(response.status).toBe(400);
    expect(store.listAccounts(user.id)).toEqual([]);
  });

  it("rejects legacy openingBalance on update without changing the account balance", async () => {
    const account = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 5000 });

    const response = await PATCH(request("PATCH", `${origin}/api/accounts/${account.id}`, {
      openingBalance: "125.00",
    }), context(account.id));

    expect(response.status).toBe(400);
    expect(store.listAccounts(user.id)).toMatchObject([{ id: account.id, balanceMinor: 5000 }]);
  });

  it("accepts current balance payloads when creating and updating accounts", async () => {
    const created = await POST(request("POST", `${origin}/api/accounts`, {
      name: "Savings", type: "bank", balance: "125.00",
    }));
    expect(created.status).toBe(201);
    const { account } = await created.json();
    expect(account.balanceMinor).toBe(12500);

    const updated = await PATCH(request("PATCH", `${origin}/api/accounts/${account.id}`, {
      balance: "250.00",
    }), context(account.id));
    expect(updated.status).toBe(200);
    expect(store.listAccounts(user.id)).toMatchObject([{ id: account.id, balanceMinor: 25000 }]);
  });
});
