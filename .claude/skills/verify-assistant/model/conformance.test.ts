// Pins the facts that Assistant.tla assumes about the real code. If one of these fails, either
// the code broke a rule the model relies on, or the code changed and the model must be updated.
// "FINDING" tests pass while a known bug exists (see SKILL.md); a failure there means it was fixed.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../../../src/lib/store";
import { providerDisclosureHash } from "../../../../src/lib/provider";
import { POST } from "../../../../src/app/api/assistant/route";

const mocks = vi.hoisted(() => ({ getStore: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), requireUser: mocks.requireUser }));

const tool = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
  choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
}), { headers: { "content-type": "application/json" } });
const ask = (prompt: string, conversationId?: string) => POST(new Request("https://tally.test/api/assistant", {
  method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
  body: JSON.stringify({ prompt, ...(conversationId ? { conversationId } : {}) }),
}));
const provider = (...responses: Response[]) => {
  const queue = [...responses];
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return queue.shift()!; }));
  return bodies;
};

let database: Database.Database;
let store: ReturnType<typeof createStore>;
let user: ReturnType<ReturnType<typeof createStore>["registerUser"]>;
const txCount = () => store.listTransactions(user.id).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T08:00:00.000Z"));
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  user = store.registerUser("verify_assistant", "test-hash");
  store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
  vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/v1");
  vi.stubEnv("CODEX_LB_MODEL", "test-model");
  vi.stubEnv("CODEX_LB_API_KEY", "test-only-key");
  vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");
  store.setAssistantConsent(user.id, providerDisclosureHash()!);
  mocks.getStore.mockReturnValue(store);
  mocks.requireUser.mockResolvedValue(user);
});
afterEach(() => { database.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("core: rules the model relies on", () => {
  it("access: no write without current consent (access = on)", async () => {
    store.setAssistantConsent(user.id, null);
    provider(tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }));
    expect((await ask("Jollibee lunch 250")).status).toBe(403);
    store.setAssistantConsent(user.id, "an-older-disclosure-hash");
    expect((await ask("Jollibee lunch 250")).status).toBe(403);
    expect(txCount()).toBe(0);
  });

  it("undo: plain assistant write is undoable for 10s, then never (undo = open -> expired)", async () => {
    provider(tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }));
    const result = await (await ask("Jollibee lunch 250")).json();
    expect(Date.parse(result.undoUntil) - Date.now()).toBe(10_000);
    vi.setSystemTime(Date.now() + 10_001);
    expect(() => store.deleteTransaction(user.id, result.transaction.id, true)).toThrow(/Undo period has expired/);
    expect(txCount()).toBe(1);
  });

  it("undo: inside the window the undo succeeds", async () => {
    provider(tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }));
    const result = await (await ask("Jollibee lunch 250")).json();
    vi.setSystemTime(Date.now() + 9_000);
    store.deleteTransaction(user.id, result.transaction.id, true);
    expect(txCount()).toBe(0);
  });

  it("repayment: has no Undo and cannot be deleted while the debt exists (txKind = repayment => undo = none)", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const result = await (await ask("Ana paid me 500")).json();
    expect(result.transaction).toBeTruthy();
    expect(result.undoUntil).toBeNull();
    expect(() => store.deleteTransaction(user.id, result.transaction.id, true)).toThrow();
    expect(() => store.deleteTransaction(user.id, result.transaction.id)).toThrow(/linked to a debt/);
  });

  it("uncertain payment wording never writes", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const result = await (await ask("Maybe Ana paid me 500?")).json();
    expect(result.transaction).toBeNull();
    expect(txCount()).toBe(0);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
  });

  it("ordinary income needs the question first: a bare yes after a finished reply records nothing", async () => {
    provider(tool("log_transaction", { amount: "100", description: "coffee", kind: "expense" }), tool("record_debt_payment", { counterparty: "Zed", amount: "500" }));
    const first = await (await ask("Coffee 100")).json();
    const second = await (await ask("Yes", first.conversationId)).json();
    expect(second.transaction).toBeNull();
    expect(txCount()).toBe(1);
  });

  it("a saving reply leaves no follow-up pending, and the stored amount follow-up is consumed by the answer", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }), tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const first = await (await ask("Ana paid me")).json();
    expect(store.getConversation(user.id, first.conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");
    await ask("500", first.conversationId);
    expect(store.getConversation(user.id, first.conversationId)!.messages.at(-1)!.followup).toBeNull();
    expect(txCount()).toBe(1);
  });
});

describe("FINDING: known bugs the model reports (a failure here means the bug was fixed)", () => {
  it("NoDuplicateIntentWrite: a chat deleted mid-flight still saves, the reply fails, a resend saves again", async () => {
    provider(tool("ask_clarification", { question: "q" }));
    const { conversationId } = await (await ask("hello")).json();
    vi.stubGlobal("fetch", vi.fn(async () => { store.deleteConversation(user.id, conversationId); return tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }); }));
    const failed = await ask("Jollibee lunch 250", conversationId);
    expect(failed.status).toBe(404);
    expect(txCount()).toBe(0);
    provider(tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }));
    expect((await ask("Jollibee lunch 250")).status).toBe(200);
    expect(txCount()).toBe(1);
  });

  it("WriteNeedsConsent: consent withdrawn while the provider call is in flight does not stop the write", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { store.setAssistantConsent(user.id, null); return tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }); }));
    expect((await ask("Jollibee lunch 250")).status).toBe(200);
    expect(txCount()).toBe(1);
    expect(store.getAssistantOptIn(user.id)).toBe(false);
  });

  it("FollowupSurvivesError: a provider failure drops the pending question from the next request's context", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    expect((await ask("500", conversationId)).status).toBe(400);
    const bodies = provider(tool("ask_clarification", { question: "q" }));
    await ask("500", conversationId);
    expect(JSON.stringify(bodies[0].messages)).not.toContain("Ana paid me");
  });

  it("PlainPromptNotTrapped: a complete unrelated prompt is swallowed by a pending repayment-amount question", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }), tool("log_transaction", { amount: "120", description: "coffee" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    const second = await (await ask("Coffee 120", conversationId)).json();
    expect(second.answer).toBe("What amount should I use for the repayment?");
    expect(txCount()).toBe(0);
  });
});
