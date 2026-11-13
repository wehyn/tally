import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { currentUser, setSession } from "../src/lib/auth";

const mocks = vi.hoisted(() => ({ cookieJar: new Map<string, string>(), getStore: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.cookieJar.has(name) ? { value: mocks.cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => {
      mocks.cookieJar.set(name, value);
    },
  }),
}));
vi.mock("../src/lib/db", () => ({ getStore: mocks.getStore }));

let database: Database.Database;
let store: ReturnType<typeof createStore>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const future = () => new Date(Date.now() + 15 * 60_000).toISOString();

function signedInCookie(userId: string) {
  mocks.cookieJar.clear();
  return setSession({ id: userId, role: "user", sessionVersion: store.getUserById(userId)!.sessionVersion }).then(() => mocks.cookieJar.get("tally_session")!);
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
  vi.clearAllMocks();
});

describe("password reset ends the old sign-in", () => {
  it("rejects a browser session issued before the reset and accepts one issued after", async () => {
    const admin = store.registerUser("reset_session_admin", "admin-hash");
    const alice = store.registerUser("reset_session_alice", "alice-hash");
    const oldCookie = await signedInCookie(alice.id);
    mocks.cookieJar.set("tally_session", oldCookie);
    expect((await currentUser())?.id).toBe(alice.id);

    store.setResetCredential(alice.id, digest("reset-code-for-alice-000000000000000000"), future());
    expect(store.consumeResetCredential(alice.id, digest("reset-code-for-alice-000000000000000000"), "new-hash")).toBe(true);

    mocks.cookieJar.set("tally_session", oldCookie);
    expect(await currentUser()).toBeNull();

    const newCookie = await signedInCookie(alice.id);
    mocks.cookieJar.set("tally_session", newCookie);
    expect((await currentUser())?.id).toBe(alice.id);
    expect(admin.role).toBe("admin");
  });

  it("does not sign in a session that carries no session version, such as one from before this change", async () => {
    const alice = store.registerUser("legacy_session_alice", "alice-hash");
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET || "local-development-only-session-secret-change-me");
    const legacy = await new SignJWT({ role: "user" }).setProtectedHeader({ alg: "HS256" }).setSubject(alice.id).setIssuedAt().setExpirationTime("1h").sign(secret);
    mocks.cookieJar.set("tally_session", legacy);

    expect(await currentUser()).toBeNull();
  });
});

describe("password reset revokes the Shortcut credential", () => {
  it("clears the Shortcut credential hash when the reset code is used", () => {
    const alice = store.registerUser("reset_shortcut_alice", "alice-hash");
    store.setShortcutCredentialHash(alice.id, "alice-shortcut-hash");
    store.setResetCredential(alice.id, digest("reset-code-for-shortcut-0000000000000000"), future());

    expect(store.consumeResetCredential(alice.id, digest("reset-code-for-shortcut-0000000000000000"), "new-hash")).toBe(true);

    expect(store.findEnabledUserByShortcutCredentialHash("alice-shortcut-hash")).toBeNull();
    expect(store.hasShortcutCredential(alice.id)).toBe(false);
  });
});

describe("disabling a user clears the outstanding reset code", () => {
  it("does not accept a reset code issued before the user was disabled and re-enabled", () => {
    const admin = store.registerUser("disable_reset_admin", "admin-hash");
    const bob = store.registerUser("disable_reset_bob", "bob-hash");
    const code = digest("reset-code-for-bob-0000000000000000000000");
    store.setResetCredential(bob.id, code, future());

    store.setUserEnabled(admin.id, bob.id, false);
    store.setUserEnabled(admin.id, bob.id, true);

    expect(store.consumeResetCredential(bob.id, code, "bob-new-hash")).toBe(false);
    expect(database.prepare("SELECT password_hash FROM users WHERE id=?").get(bob.id)).toEqual({ password_hash: "bob-hash" });
  });
});
