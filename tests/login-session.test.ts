import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { currentUser } from "../src/lib/auth";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as register } from "../src/app/api/auth/register/route";

const mocks = vi.hoisted(() => ({ cookieJar: new Map<string, string>(), getStore: vi.fn(), duringCompare: null as null | (() => void) }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.cookieJar.has(name) ? { value: mocks.cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => { mocks.cookieJar.set(name, value); },
  }),
}));
vi.mock("../src/lib/db", () => ({ getStore: mocks.getStore }));
vi.mock("bcryptjs", () => ({
  // The reset commits while the sign-in is awaiting the password check, as it can on a real server.
  compare: async (password: string, passwordHash: string) => { mocks.duringCompare?.(); return password === "old-password" && passwordHash === "old-hash"; },
  hash: async (password: string) => `hash:${password}`,
}));

let database: Database.Database;
let store: ReturnType<typeof createStore>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function post(path: string, body: object, ip: string) {
  return new Request(`https://tally.test/api/auth/${path}`, {
    method: "POST",
    headers: { origin: "https://tally.test", "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  mocks.getStore.mockReturnValue(store);
});
afterEach(() => {
  database.close();
  mocks.cookieJar.clear();
  mocks.duringCompare = null;
  vi.clearAllMocks();
});

describe("a session carries the version of the row the password was checked against", () => {
  it("does not keep a sign-in alive that checked the old password when a reset committed before the cookie was set", async () => {
    store.registerUser("login_race_admin", "admin-hash");
    const alice = store.registerUser("login_race_alice", "old-hash");
    store.setResetCredential(alice.id, digest("reset-code"), new Date(Date.now() + 60_000).toISOString());
    mocks.duringCompare = () => { expect(store.consumeResetCredential(alice.id, digest("reset-code"), "new-hash")).toBe(true); };

    await login(post("login", { username: "login_race_alice", password: "old-password" }, "10.0.0.1"));

    expect(store.getUserById(alice.id)?.sessionVersion).toBe(1);
    expect(await currentUser()).toBeNull();
  });

  it("signs in normally when nothing changed", async () => {
    store.registerUser("login_plain_admin", "admin-hash");
    const alice = store.registerUser("login_plain_alice", "old-hash");

    const response = await login(post("login", { username: "login_plain_alice", password: "old-password" }, "10.0.0.2"));

    expect(response.status).toBe(200);
    expect((await currentUser())?.id).toBe(alice.id);
  });

  it("signs a new registration in", async () => {
    const response = await register(post("register", { username: "login_new_user", password: "a-long-password-1" }, "10.0.0.3"));

    expect(response.status).toBe(201);
    expect((await currentUser())?.username).toBe("login_new_user");
  });
});
