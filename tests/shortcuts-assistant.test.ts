import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { providerDisclosureHash } from "../src/lib/provider";
import { POST } from "../src/app/api/shortcuts/assistant/route";

const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));

vi.mock("@/lib/db", () => ({ getStore: mocks.getStore }));

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let user: ReturnType<ReturnType<typeof createStore>["registerUser"]>;
let credential: string;

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  user = store.registerUser("shortcut_assistant", "test-hash");
  store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
  credential = randomBytes(32).toString("base64url");
  store.setShortcutCredentialHash(user.id, createHash("sha256").update(credential).digest("hex"));
  vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/v1");
  vi.stubEnv("CODEX_LB_MODEL", "test-model");
  vi.stubEnv("CODEX_LB_API_KEY", "test-only-key");
  vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");
  store.setAssistantConsent(user.id, providerDisclosureHash()!);
  mocks.getStore.mockReturnValue(store);
});

afterEach(() => {
  database.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function assistantRequest(body: unknown, bearer = credential, url = "https://tally.test/api/shortcuts/assistant") {
  return new Request(url, {
    method: "POST",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function providerReply(question = "Here is your answer.") {
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: {
      name: "ask_clarification", arguments: JSON.stringify({ question }),
    } }] } }],
  }), { headers: { "content-type": "application/json" } });
}

describe("Shortcut assistant endpoint", () => {
  it("uses the owner credential, sends the trimmed prompt to Ask Tally, and returns a Shortcut response", async () => {
    let providerRequest: { messages: { role: string; content: string }[] } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerRequest = JSON.parse(String(init?.body));
      return providerReply();
    }));

    const response = await POST(assistantRequest({ prompt: "  Show my spending  " }));
    const result = await response.json();
    const conversation = store.getConversation(user.id, result.conversationId);

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ answer: "Here is your answer.", conversationId: expect.any(String) });
    expect(Object.keys(result).sort()).toEqual(["answer", "conversationId"]);
    expect(providerRequest?.messages.at(-1)).toEqual({ role: "user", content: "Show my spending" });
    expect(conversation?.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "Show my spending"], ["assistant", "Here is your answer."],
    ]);

    const followup = await POST(assistantRequest({ prompt: "And last month?", conversationId: result.conversationId }));
    const followupResult = await followup.json();
    expect(followupResult).toMatchObject({ answer: "Here is your answer.", conversationId: result.conversationId });
    expect(store.getConversation(user.id, result.conversationId)?.messages).toHaveLength(4);
  });

  it("rejects missing, invalid, malformed, body, and query-string credentials without reaching the provider", async () => {
    const fetch = vi.fn(async () => providerReply());
    vi.stubGlobal("fetch", fetch);

    const missing = await POST(assistantRequest({ prompt: "hello" }, ""));
    const invalid = await POST(assistantRequest({ prompt: "hello" }, randomBytes(32).toString("base64url")));
    const malformed = await POST(assistantRequest({ prompt: "hello" }, "wrong-secret"));
    const body = await POST(assistantRequest({ prompt: "hello", credential }, ""));
    const query = await POST(assistantRequest({ prompt: "hello" }, "", `https://tally.test/api/shortcuts/assistant?credential=${credential}`));

    expect([missing.status, invalid.status, malformed.status, body.status, query.status]).toEqual([401, 401, 401, 401, 401]);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.listConversations(user.id)).toHaveLength(0);
  });

  it("rejects a revoked credential", async () => {
    store.setShortcutCredentialHash(user.id, null);
    vi.stubGlobal("fetch", vi.fn(async () => providerReply()));

    const response = await POST(assistantRequest({ prompt: "hello" }));

    expect(response.status).toBe(401);
    expect(store.listConversations(user.id)).toHaveLength(0);
  });

  it("rejects credentials belonging to disabled users", async () => {
    const disabledUser = store.registerUser("shortcut_disabled", "disabled-hash");
    const disabledCredential = randomBytes(32).toString("base64url");
    store.setShortcutCredentialHash(disabledUser.id, createHash("sha256").update(disabledCredential).digest("hex"));
    store.setUserEnabled(user.id, disabledUser.id, false);
    const fetch = vi.fn(async () => providerReply());
    vi.stubGlobal("fetch", fetch);

    const response = await POST(assistantRequest({ prompt: "hello" }, disabledCredential));

    expect(response.status).toBe(401);
    expect(store.listConversations(disabledUser.id)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a valid credential inside its owner's conversations", async () => {
    const other = store.registerUser("shortcut_other", "other-hash");
    const otherConversation = store.createConversation(other.id, "private conversation");
    const fetch = vi.fn(async () => providerReply());
    vi.stubGlobal("fetch", fetch);

    const response = await POST(assistantRequest({ prompt: "hello", conversationId: otherConversation }));

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.getConversation(other.id, otherConversation)?.messages).toHaveLength(0);
    expect(store.listConversations(user.id)).toHaveLength(0);
  });

  it("requires opt-in for the current provider disclosure and configured provider", async () => {
    const fetch = vi.fn(async () => providerReply());
    vi.stubGlobal("fetch", fetch);
    store.setAssistantConsent(user.id, null);
    const optedOut = await POST(assistantRequest({ prompt: "hello" }));

    store.setAssistantConsent(user.id, providerDisclosureHash()!);
    vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Changed disclosure");
    const staleDisclosure = await POST(assistantRequest({ prompt: "hello" }));

    vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");
    store.setAssistantConsent(user.id, providerDisclosureHash()!);
    vi.stubEnv("CODEX_LB_API_KEY", "");
    const unconfigured = await POST(assistantRequest({ prompt: "hello" }));

    expect([optedOut.status, staleDisclosure.status, unconfigured.status]).toEqual([403, 403, 503]);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.listConversations(user.id)).toHaveLength(0);
  });

  it("rejects empty, oversized, and oversized-body prompts before creating a conversation", async () => {
    const empty = await POST(assistantRequest({ prompt: "   " }));
    const missingPrompt = await POST(assistantRequest({}));
    const oversizedPrompt = await POST(assistantRequest({ prompt: "x".repeat(2001) }));
    const invalidConversation = await POST(assistantRequest({ prompt: "hello", conversationId: "not-a-uuid" }));
    const oversizedBody = await POST(assistantRequest({ prompt: "hello", extra: "x".repeat(64_100) }));
    const malformedJson = await POST(new Request("https://tally.test/api/shortcuts/assistant", {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: "{",
    }));

    expect([empty.status, missingPrompt.status, oversizedPrompt.status, invalidConversation.status, oversizedBody.status, malformedJson.status])
      .toEqual([400, 400, 400, 400, 413, 400]);
    expect(store.listConversations(user.id)).toHaveLength(0);
  });

  it("rate-limits requests for one credential owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerReply()));

    const responses: Response[] = [];
    for (let index = 0; index < 31; index++) {
      responses.push(await POST(assistantRequest({ prompt: "hello" })));
    }

    expect(responses.slice(0, 30).every((response) => response.status === 200)).toBe(true);
    expect(responses[30].status).toBe(429);
  });
});
