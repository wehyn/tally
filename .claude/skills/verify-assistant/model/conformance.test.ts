// Pins the facts that Assistant.tla assumes about the real code. If one of these fails, either
// the code broke a rule the model relies on, or the code changed and the model must be updated.
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

// A model call that waits for release(), so a test decides which of two requests commits first.
const gated = (answer: () => Response) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls = vi.fn(async () => { await gate; return answer(); });
  vi.stubGlobal("fetch", calls);
  return { release, entered: (count: number) => vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(count)) };
};
const conversationChanged = { error: "Your conversation changed while this ran. Send that again." };

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

describe("regressions: the findings stay fixed", () => {
  it("NoDuplicateIntentWrite (fixed): a chat deleted mid-flight saves nothing, and a resend saves once", async () => {
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

  it("WriteNeedsConsent (fixed): consent withdrawn while the provider call is in flight stops the write", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { store.setAssistantConsent(user.id, null); return tool("log_transaction", { amount: "250", description: "lunch", kind: "expense" }); }));
    expect((await ask("Jollibee lunch 250")).status).toBe(403);
    expect(txCount()).toBe(0);
    expect(store.getAssistantOptIn(user.id)).toBe(false);
  });

  it("FollowupSurvivesError (fixed): a provider failure keeps the pending question in the next request's context", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    expect((await ask("500", conversationId)).status).toBe(400);
    const bodies = provider(tool("ask_clarification", { question: "q" }));
    await ask("500", conversationId);
    expect(JSON.stringify(bodies[0].messages)).toContain("Ana paid me");
  });

  it("PlainPromptNotTrapped (fixed): an unrelated prompt re-asks and writes nothing, an explicit cancel clears the question, and the next prompt runs in a clean context", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    const coffee = () => tool("log_transaction", { amount: "120", description: "coffee", kind: "expense", category: "Food" });
    provider(tool("record_debt_payment", { counterparty: "Ana" }), coffee());
    const { conversationId } = await (await ask("Ana paid me")).json();
    const reasked = await (await ask("Coffee 120", conversationId)).json();
    expect(reasked.answer).toContain("What amount should I use for the repayment?");
    expect(reasked.transaction).toBeNull();
    expect(txCount()).toBe(0);
    const cancelled = await (await ask("cancel", conversationId)).json();
    expect(cancelled).toMatchObject({ answer: "Okay, I dropped that question. Nothing was recorded.", transaction: null });
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBeNull();
    const bodies = provider(coffee());
    const saved = await (await ask("Coffee 120", conversationId)).json();
    expect(JSON.stringify(bodies[0].messages)).not.toContain("Ana paid me");
    expect(saved.transaction).toMatchObject({ kind: "expense", amountMinor: 12_000 });
    expect(txCount()).toBe(1);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
  });

  it("PlainPromptNotTrapped (amount forms): an amount-only reply with a peso sign or word answers the pending amount question instead of replacing it", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }), tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    const second = await (await ask("₱500", conversationId)).json();
    expect(second.answer).toContain("repayment from Ana");
    expect(store.listDebts(user.id)[0].amountMinor).toBe(50_000);
    expect(txCount()).toBe(1);
  });

  it("AnswerNotReplaced (hedged): a hedged or negated amount reply keeps the pending question, so the guard asks first and writes nothing", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    for (const reply of ["maybe 500", "I think 500", "not 500"]) {
      provider(tool("record_debt_payment", { counterparty: "Ana" }));
      const { conversationId } = await (await ask("Ana paid me")).json();
      const bodies = provider(tool("log_transaction", { amount: "500", kind: "expense", category: "Other" }));
      const second = await (await ask(reply, conversationId)).json();
      expect(JSON.stringify(bodies[0].messages)).toContain("Ana paid me");
      expect(second.transaction).toBeNull();
    }
    expect(txCount()).toBe(0);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
  });

  it("AnswerNotReplaced (detail): an amount with a detail keeps the pending question and asks for the amount again, writing nothing", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    for (const reply of ["500 cash", "about 500", "P500"]) {
      provider(tool("record_debt_payment", { counterparty: "Ana" }));
      const { conversationId } = await (await ask("Ana paid me")).json();
      const bodies = provider(tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
      const second = await (await ask(reply, conversationId)).json();
      expect(JSON.stringify(bodies[0].messages)).toContain("Ana paid me");
      expect(second.answer).toBe("What amount should I use for the repayment? Reply with the amount, or say cancel to drop this.");
      expect(second.transaction).toBeNull();
    }
    expect(txCount()).toBe(0);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
  });

  it("AnswerNotReplaced (category word): a reply with a category word, a hedge or an account named like a category keeps the question and writes nothing", async () => {
    store.createAccount(user.id, { name: "Food Wallet", type: "cash", openingMinor: 0 });
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    for (const reply of ["she paid back the food money, 500", "for the food, 500", "bayad sa food 500", "I guess Food 500", "siguro Food 500", "to Food Wallet 500", "She paid 500 for lunch"]) {
      provider(tool("record_debt_payment", { counterparty: "Ana" }));
      const { conversationId } = await (await ask("Ana paid me")).json();
      const bodies = provider(tool("log_transaction", { amount: "500", kind: "expense", category: "Food", account: "Food Wallet" }));
      const second = await (await ask(reply, conversationId)).json();
      expect(JSON.stringify(bodies[0].messages)).toContain("Ana paid me");
      expect(second.transaction).toBeNull();
      expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");
    }
    expect(txCount()).toBe(0);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
  });

  it("AnswerNotReplaced (read-only): a debt list or a finance answer leaves a pending repayment question, so the amount still repays Ana", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    const lastFollowup = () => store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup;

    const listed = await (await ask("List my debts", conversationId)).json();
    expect(listed.answer).toContain("Ana: ₱1,000.00");
    expect(lastFollowup()).toBe("repayment_amount");
    provider(tool("finance_question", { start: "2026-10-01", end: "2026-10-09" }));
    const answered = await (await ask("How much did I spend this month?", conversationId)).json();
    expect(answered.answer).toContain("Total Spent");
    expect(lastFollowup()).toBe("repayment_amount");

    const bodies = provider(tool("log_transaction", { amount: "500", kind: "expense", category: "Other" }));
    const repaid = await (await ask("500", conversationId)).json();
    expect(JSON.stringify(bodies[0].messages)).toContain("Ana paid me");
    expect(repaid.answer).toContain("repayment from Ana");
    expect(store.listDebts(user.id)[0].amountMinor).toBe(50_000);
    expect(txCount()).toBe(1);
    expect(lastFollowup()).toBeNull();
  });

  it("AnswerNotReplaced (read-only): a cancel after a read-only answer still drops the question, and a read-only turn with nothing pending stores none", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    const none = await (await ask("List my debts")).json();
    expect(store.getConversation(user.id, none.conversationId)!.messages.at(-1)!.followup).toBeNull();
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    await ask("List my debts", conversationId);
    const cancelled = await (await ask("cancel", conversationId)).json();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("PlainPromptNotTrapped (long run): six re-asks keep the message that started the question, so the amount still repays Ana", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    const coffee = () => tool("log_transaction", { amount: "120", description: "coffee", kind: "expense", category: "Food" });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    for (let round = 0; round < 6; round++) {
      provider(coffee());
      expect((await (await ask("Coffee 120", conversationId)).json()).transaction).toBeNull();
    }
    const bodies = provider(tool("log_transaction", { amount: "500", kind: "expense", category: "Other" }));
    const repaid = await (await ask("500", conversationId)).json();
    expect(JSON.stringify(bodies[0].messages)).toContain("Ana paid me");
    expect(repaid.answer).toContain("repayment from Ana");
    expect(store.listDebts(user.id)[0].amountMinor).toBe(50_000);
    expect(txCount()).toBe(1);
  });

  it("PlainPromptNotTrapped (stays cancelled): the dropped question is not reloaded by a later turn of the new request", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    const coffee = (account: string) => tool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food", account });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    await ask("never mind", conversationId);
    provider(coffee("Missing"), coffee("Wallet"));
    await ask("Coffee 120 from Missing", conversationId);
    const third = await (await ask("Wallet", conversationId)).json();
    expect(third.transaction).toMatchObject({ kind: "expense", amountMinor: 12_000 });
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
  });

  it("PlainPromptNotTrapped (payer): an unrelated prompt re-asks and an explicit cancel clears a pending payer question", async () => {
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Dad", amountMinor: 30_000 });
    provider(tool("record_debt_repayment", { counterparty: "Mom", amount: "100" }), tool("log_transaction", { amount: "120", description: "coffee", kind: "expense", category: "Food" }));
    const { conversationId } = await (await ask("I paid Mom and Dad 100")).json();
    const second = await (await ask("Coffee 120", conversationId)).json();
    expect(second.transaction).toBeNull();
    expect(txCount()).toBe(0);
    const cancelled = await (await ask("cancel", conversationId)).json();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("OneWritePerQuestion (fixed): the same answer sent twice while the first waits on the model writes once, and the second is told to send it again", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    const model = gated(() => tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const first = ask("500", conversationId);
    const second = ask("500", conversationId);
    await model.entered(2);
    model.release();
    const [saved, repeated] = await Promise.all([first, second]);
    expect(saved.status).toBe(200);
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toEqual(conversationChanged);
    expect(txCount()).toBe(1);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(50_000);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(50_000);
    expect(store.getConversation(user.id, conversationId)!.messages.filter((message) => message.content === "500")).toHaveLength(1);
  });

  it("CancelledNeverAnswered (fixed): an answer still waiting on the model when the question is cancelled stores nothing", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    provider(tool("record_debt_payment", { counterparty: "Ana" }));
    const { conversationId } = await (await ask("Ana paid me")).json();
    const model = gated(() => tool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const late = ask("500", conversationId);
    await model.entered(1);
    const cancelled = await (await ask("cancel", conversationId)).json();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    model.release();
    const response = await late;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(conversationChanged);
    expect(txCount()).toBe(0);
    expect(store.listDebts(user.id)[0].amountMinor).toBe(100_000);
    expect(store.getConversation(user.id, conversationId)!.messages.map((message) => message.content)).not.toContain("500");
  });

  it("NoPendingNoCancel: cancel with no pending question is an ordinary prompt", async () => {
    const bodies = provider(tool("ask_clarification", { question: "What should I cancel?" }));
    const result = await (await ask("cancel")).json();
    expect(bodies).toHaveLength(1);
    expect(result.answer).toBe("What should I cancel?");
  });
});
