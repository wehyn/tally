import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { HttpError } from "../src/lib/api";
import { GET as getSettings } from "../src/app/api/settings/route";
import {
  DELETE as revokeShortcutCredential,
  POST as issueShortcutCredential,
} from "../src/app/api/settings/shortcut-credential/route";

const mocks = vi.hoisted(() => ({ getStore: vi.fn(), requireUser: vi.fn() }));

vi.mock("@/lib/db", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireUser: mocks.requireUser };
});

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let user: ReturnType<ReturnType<typeof createStore>["registerUser"]>;

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  user = store.registerUser("shortcut_settings", "test-hash");
  mocks.getStore.mockReturnValue(store);
  mocks.requireUser.mockResolvedValue(user);
});

afterEach(() => {
  database.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function credentialRequest(method: "POST" | "DELETE", origin = "https://tally.test") {
  return new Request("https://tally.test/api/settings/shortcut-credential", {
    method,
    headers: { origin },
  });
}

describe("Shortcut credential settings", () => {
  it("returns a high-entropy secret once and stores only its hash", async () => {
    const response = await issueShortcutCredential(credentialRequest("POST"));
    const { credential } = await response.json();
    const stored = database.prepare("SELECT shortcut_credential_hash FROM users WHERE id=?").get(user.id) as {
      shortcut_credential_hash: string;
    };

    expect(response.status).toBe(200);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.shortcut_credential_hash).toBe(createHash("sha256").update(credential).digest("hex"));
    expect(stored.shortcut_credential_hash).not.toBe(credential);

    const settings = await getSettings();
    const body = await settings.json();
    expect(body.shortcutCredentialActive).toBe(true);
    expect(JSON.stringify(body)).not.toContain(credential);
  });

  it("rotates the credential and invalidates the previous secret", async () => {
    const first = await issueShortcutCredential(credentialRequest("POST")).then((response) => response.json());
    const second = await issueShortcutCredential(credentialRequest("POST")).then((response) => response.json());

    expect(second.credential).not.toBe(first.credential);
    expect(store.findEnabledUserByShortcutCredentialHash(createHash("sha256").update(first.credential).digest("hex"))).toBeNull();
    expect(store.findEnabledUserByShortcutCredentialHash(createHash("sha256").update(second.credential).digest("hex"))).toEqual({ id: user.id });
  });

  it("revokes the active credential", async () => {
    const { credential } = await issueShortcutCredential(credentialRequest("POST")).then((response) => response.json());
    const response = await revokeShortcutCredential(credentialRequest("DELETE"));

    expect(response.status).toBe(200);
    expect(store.findEnabledUserByShortcutCredentialHash(createHash("sha256").update(credential).digest("hex"))).toBeNull();
    expect(store.hasShortcutCredential(user.id)).toBe(false);
    expect((await (await getSettings()).json()).shortcutCredentialActive).toBe(false);
  });

  it("requires an authenticated same-origin session to create or revoke credentials", async () => {
    await issueShortcutCredential(credentialRequest("POST"));
    const before = database.prepare("SELECT shortcut_credential_hash FROM users WHERE id=?").get(user.id);

    mocks.requireUser.mockRejectedValueOnce(new HttpError(401, "Sign in to continue."));
    const unauthenticatedPost = await issueShortcutCredential(credentialRequest("POST"));
    mocks.requireUser.mockRejectedValueOnce(new HttpError(401, "Sign in to continue."));
    const unauthenticatedDelete = await revokeShortcutCredential(credentialRequest("DELETE"));
    const crossOriginPost = await issueShortcutCredential(credentialRequest("POST", "https://attacker.example"));
    const crossOriginDelete = await revokeShortcutCredential(credentialRequest("DELETE", "https://attacker.example"));

    expect([unauthenticatedPost.status, unauthenticatedDelete.status, crossOriginPost.status, crossOriginDelete.status])
      .toEqual([401, 401, 403, 403]);
    expect(database.prepare("SELECT shortcut_credential_hash FROM users WHERE id=?").get(user.id)).toEqual(before);
  });
});
