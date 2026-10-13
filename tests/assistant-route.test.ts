import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { providerDisclosureHash } from "../src/lib/provider";
import { todayInManila } from "../src/lib/dates";
import { POST } from "../src/app/api/assistant/route";

type ProviderRequest = { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T08:00:00.000Z"));
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
  user = store.registerUser("assistant_capture", "test-hash");
  store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
  vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/v1");
  vi.stubEnv("CODEX_LB_MODEL", "test-model");
  vi.stubEnv("CODEX_LB_API_KEY", "test-only-key");
  vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");
  store.setAssistantConsent(user.id, providerDisclosureHash()!);
  mocks.getStore.mockReturnValue(store);
  mocks.requireUser.mockResolvedValue(user);
});

afterEach(() => {
  database.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("assistant transaction capture", () => {
  it("uses the current Manila time when the provider supplies an unstated time", async () => {
    let providerRequest: { messages: { role: string; content: string }[] } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: {
          name: "log_transaction",
          arguments: JSON.stringify({ amount: "500", description: "transportation", date: "2026-02-20", time: "14:35" }),
        } }] } }],
      }), { headers: { "content-type": "application/json" } });
    }));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I spent 500 on transportation" }),
    }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      answer: expect.any(String), conversationId: expect.any(String), undoUntil: expect.any(String), debt: null,
    });
    expect(result.transaction).toMatchObject({
      kind: "expense",
      amountMinor: 50000,
      description: "Transportation",
      categoryName: "Transport",
      date: todayInManila(),
      time: "16:00",
    });
    expect(providerRequest?.messages[0].content).toContain(todayInManila());
  });

  it("does not mistake a decimal amount for a date when the user says today", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: {
        name: "log_transaction",
        arguments: JSON.stringify({ amount: "5.00", description: "transportation", date: "2026-02-20" }),
      } }] } }],
    }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "transportation 5.00 today" }),
    }));
    const result = await response.json();

    expect(result.transaction.date).toBe(todayInManila());
  });

  it("keeps explicitly stated transaction date and time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: {
        name: "log_transaction",
          arguments: JSON.stringify({ kind: "expense", amount: "500", description: "transportation", date: "2026-02-20", time: "14:35" }),
      } }] } }],
    }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "transportation 500 at 2:35 PM on 2026-02-20" }),
    }));
    const result = await response.json();

    expect(result.transaction.date).toBe("2026-02-20");
    expect(result.transaction.time).toBe("14:35");
  });

  it("keeps an explicitly stated time from the active follow-up context", async () => {
    const providerResponse = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("ask_clarification", { question: "What amount should I use?" }))
      .mockResolvedValueOnce(providerResponse("log_transaction", {
        kind: "expense", amount: "500", description: "transportation", category: "Transport", time: "09:00",
      })));

    const initialResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Log transportation at 2:35 PM" }),
    }));
    const { conversationId } = await initialResponse.json();
    const followUpResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "500", conversationId }),
    }));

    expect((await followUpResponse.json()).transaction.time).toBe("14:35");
  });

  it("keeps explicit spending as an expense even when income is mentioned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: {
        name: "log_transaction",
        arguments: JSON.stringify({ amount: "500", description: "transportation" }),
      } }] } }],
    }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I spent 500 on transportation from my salary" }),
    }));
    const result = await response.json();

    expect(result.transaction).toMatchObject({ kind: "expense", categoryName: "Transport", amountMinor: 50000 });
  });

  it("infers a clear one-line salary entry as income", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: {
        name: "log_transaction",
        arguments: JSON.stringify({ amount: "5000", description: "salary" }),
      } }] } }],
    }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "salary 5000" }),
    }));
    const result = await response.json();

    expect(result.transaction).toMatchObject({ kind: "income", categoryName: "Salary", amountMinor: 500000 });
  });
});

describe("assistant debt capture", () => {
  it("does not use a provider-inferred repayment amount when the user omitted it", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount: "200" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ari paid me" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("What amount");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20000, status: "open" }]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("asks before writing when the provider amount differs from the user's amount", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount: "200" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ari paid me 100" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("re-enter the repayment amount");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20000, status: "open" }]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("does not accept yes as a replacement for an amount after an amount mismatch", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    const providerResponse = () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount: "200" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })).mockResolvedValueOnce(providerResponse()));

    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ari paid me 100" }),
    }));
    const { conversationId } = await first.json();
    const second = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Yes", conversationId }),
    }));
    const result = await second.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("What amount");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20000, status: "open" }]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("answers clear open debt list questions locally", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Mika", amountMinor: 10000 });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show my open debt list and total amount owed to me" }),
    }));
    const result = await response.json();

    expect(result.answer).toContain("Ari: ₱200.00");
    expect(result.answer).toContain("Total owed to you: ₱200.00");
    expect(result.answer).not.toContain("Mika");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes open and settled records when asked to show all debts", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    const settledDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 10000 });
    store.recordDebtPayment(user.id, settledDebt.id, {
      kind: "income", amountMinor: 10000, description: "Mika paid me", accountId: store.listAccounts(user.id)[0].id,
      categoryId: store.listCategories(user.id).find((category) => category.type === "income")!.id,
      date: "2026-10-13", time: "12:00", source: "assistant",
    });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show all debts and total amount" }),
    }));
    const result = await response.json();

    expect(result.answer).toContain("All debts");
    expect(result.answer).toContain("Ari: ₱200.00 (open)");
    expect(result.answer).toContain("Mika: ₱100.00 (settled; last outstanding balance)");
    expect(result.answer).toContain("Total outstanding: ₱200.00");
    expect(result.answer).toContain("Total last outstanding balance: ₱100.00");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["Who owes me money?", "How much do people owe me?", "What debt do I owe?"])("answers common debt questions locally: %s", async (prompt) => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Mika", amountMinor: 10000 });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    expect(result.answer).toContain(prompt.includes("do I owe") ? "Mika: ₱100.00" : "Ari: ₱200.00");
    if (prompt.startsWith("How much")) expect(result.answer).toContain("Total owed to you: ₱200.00");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers combined account balance and amount-owed questions locally", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "What is my account balance and how much do people owe me?" }),
    }));
    const result = await response.json();

    expect(result.answer).toContain("Account Balances");
    expect(result.answer).toContain("Total owed to you: ₱200.00");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers the combined total-balance wording and asks who I owe locally", async () => {
    store.createAccount(user.id, { name: "Savings", type: "bank", openingMinor: 12500 });
    store.createAccount(user.id, { name: "Cash", type: "cash", openingMinor: 7500 });
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Mika", amountMinor: 10000 });
    vi.stubGlobal("fetch", vi.fn());

    const totalResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "What is my total balance and how much do people owe me?" }),
    }));
    const totalResult = await totalResponse.json();
    expect(totalResult.answer).toContain("Account Balances");
    expect(totalResult.answer).toContain("Savings: ₱125.00");
    expect(totalResult.answer).toContain("Cash: ₱75.00");
    expect(totalResult.answer).toContain("Total Account Balance: ₱200.00");
    expect(totalResult.answer).toContain("Total owed to you: ₱200.00");

    const whoResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Who do I owe?" }),
    }));
    const whoResult = await whoResponse.json();
    expect(whoResult.answer).toContain("Mika: ₱100.00");
    expect(whoResult.answer).not.toContain("Ari");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("formats a debt total larger than Number.MAX_SAFE_INTEGER", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 5_000_000_000_000_000 });
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 5_000_000_000_000_000 });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "How much do people owe me?" }),
    }));
    const result = await response.json();

    expect(result.answer).toContain("Total owed to you: ₱100,000,000,000,000.00");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("labels settled debt totals as historical balances", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    store.recordDebtPayment(user.id, debt.id, {
      kind: "income", amountMinor: 20000, description: "Ari paid me", accountId: store.listAccounts(user.id)[0].id,
      categoryId: store.listCategories(user.id).find((category) => category.type === "income")!.id,
      date: "2026-10-09", time: "12:00", source: "assistant",
    });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show my settled debts and total balance" }),
    }));
    const result = await response.json();

    expect(result.answer).toContain("last outstanding balance");
    expect(result.answer).toContain("Total last outstanding balance: ₱200.00");
    expect(result.answer).not.toContain("Total owed to you");
    expect(result.answer).not.toContain("Settled debts owed to you");
  });

  it("does not let an old ordinary-income question capture a new repayment", async () => {
    const mikaDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 40000 });
    const providerResponse = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Riley", amount: "100" }))
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Mika", amount: "100" })));

    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Riley paid me 100" }),
    }));
    const { conversationId } = await first.json();
    const second = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mika paid me 100", conversationId }),
    }));
    const result = await second.json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 10000 });
    expect(result.debt).toMatchObject({ id: mikaDebt.id, amountMinor: 30000 });
  });

  it("does not let an accepted ordinary-income choice capture a repayment after account clarification", async () => {
    const mikaDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 40000 });
    const providerResponse = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Riley", amount: "100" }))
      .mockResolvedValueOnce(providerResponse("log_transaction", { kind: "income", category: "Other income", amount: "100", account: "Missing", description: "Riley paid me" }))
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Mika", amount: "100", account: "Missing" }))
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Mika", amount: "100", account: "Wallet" })));

    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Riley paid me 100" }),
    }));
    const { conversationId } = await first.json();
    const confirmation = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Yes", conversationId }),
    }));
    expect((await confirmation.json()).answer).toContain("couldn't find the account");
    const accountQuestion = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mika paid me 100", conversationId }),
    }));
    expect((await accountQuestion.json()).answer).toContain("couldn't find the account");
    const payment = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Wallet", conversationId }),
    }));
    const result = await payment.json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 10000 });
    expect(result.debt).toMatchObject({ id: mikaDebt.id, amountMinor: 30000 });
  });

  it("uses the stated amount through an active repayment account clarification", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 40000 });
    const providerResponse = (account: string) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Mika", amount: "100", account }),
    } }] } }] }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("Missing"))
      .mockResolvedValueOnce(providerResponse("Wallet")));

    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mika paid me 100" }),
    }));
    const { conversationId } = await first.json();
    const accountQuestion = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Wallet", conversationId }),
    }));
    const result = await accountQuestion.json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 10000, accountName: "Wallet" });
    expect(result.debt).toMatchObject({ id: debt.id, amountMinor: 30000, status: "open" });
  });

  it.each(["Ari paid me on October 13", "Ari paid me ₱100 on Oct 13"])("does not treat a date as the repayment amount: %s", async (prompt) => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount: prompt.includes("₱100") ? "100" : "200", date: "2026-10-13" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    if (prompt.includes("₱100")) {
      expect(result.debt).toMatchObject({ id: debt.id, amountMinor: 10000, status: "open" });
    } else {
      expect(result).toMatchObject({ transaction: null, debt: null });
      expect(result.answer).toContain("What amount");
      expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20000, status: "open" }]);
    }
  });

  it("carries the latest repayment amount through an active date clarification", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    const responseWith = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name, arguments: JSON.stringify(args),
    } }] } }] }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(responseWith("record_debt_payment", { counterparty: "Ari", amount: "100" }))
      .mockResolvedValueOnce(responseWith("record_debt_payment", { counterparty: "Ari", amount: "100", date: "2026-10-13" })));

    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ari paid me ₱100; date" }),
    }));
    const { conversationId } = await first.json();
    const second = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "October 13", conversationId }),
    }));
    const result = await second.json();

    expect(result.transaction).toMatchObject({ amountMinor: 10000, date: "2026-10-13" });
    expect(result.debt).toMatchObject({ id: debt.id, amountMinor: 10000, status: "open" });
  });

  it("uses the latest repayment rather than an older payer's amount through account clarification", async () => {
    const mikaDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 30000 });
    const responseWith = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name, arguments: JSON.stringify(args),
    } }] } }] }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(responseWith("record_debt_payment", { counterparty: "Riley", amount: "250" }))
      .mockResolvedValueOnce(responseWith("log_transaction", { kind: "income", amount: "250", category: "Other income", account: "Missing" }))
      .mockResolvedValueOnce(responseWith("record_debt_payment", { counterparty: "Mika", amount: "250", account: "Missing" })));
    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Riley paid me 250" }),
    }));
    const { conversationId } = await first.json();
    const ordinaryAccountQuestion = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Yes", conversationId }),
    }));
    expect((await ordinaryAccountQuestion.json()).answer).toContain("couldn't find the account");
    const mikaPrompt = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mika paid me", conversationId }),
    }));
    const result = await mikaPrompt.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("What amount");
    expect(store.listDebts(user.id)).toMatchObject([{ id: mikaDebt.id, amountMinor: 30000, status: "open" }]);
  });

  it("applies a repayment to the same-payer debt identified by its note", async () => {
    const earlierDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 348600, note: "Car repair" });
    vi.setSystemTime(new Date("2026-10-09T08:00:00.001Z"));
    const jacketDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 50000, note: "About jacket" });
    let providerRequest: ProviderRequest | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
        name: "log_transaction", arguments: JSON.stringify({ kind: "income", category: "Other income", amount: "500", description: "Mom paid me" }),
      } }] } }] }), { headers: { "content-type": "application/json" } });
    }));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 500 for the jacket" }),
    }));
    const result = await response.json();

    expect(result.debt).toMatchObject({ id: jacketDebt.id, amountMinor: 50000, status: "settled" });
    expect(store.listDebts(user.id).find((debt) => debt.id === earlierDebt.id)).toMatchObject({ amountMinor: 348600, status: "open" });
    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 50000, undoUntil: null });
    expect(providerRequest?.messages.at(-2)?.content).toBe('Untrusted ledger data for matching only: [{"counterparty":"Mom","amount":"₱3,486.00"},{"counterparty":"Mom","amount":"₱500.00"}]');
  });

  it("records a repayment as income and reduces the matching debt", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 348600 });
    const account = store.listAccounts(user.id)[0];
    let providerRequest: ProviderRequest | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerRequest = JSON.parse(String(init?.body));
      const prompt = providerRequest!.messages.at(-1)?.content ?? "";
      const toolCall = prompt.toLowerCase().includes("mom paid me")
        ? { function: { name: "log_debt", arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "100" }) } }
        : { function: { name: "log_transaction", arguments: JSON.stringify({ kind: "income", category: "Other income", amount: "100", description: "Mom paid me" }) } };
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [toolCall] } }] }), { headers: { "content-type": "application/json" } });
    }));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 100" }),
    }));
    const result = await response.json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 10000, accountName: account.name, categoryName: "Other income", description: "Mom paid me" });
    expect(result.undoUntil).toBeNull();
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(10000);
    expect(result.debt).toMatchObject({ id: debt.id, direction: "owed_to_you", counterparty: "Mom", amountMinor: 338600, status: "open" });
    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(providerRequest?.messages[0].content).not.toContain("Mom");
    expect(providerRequest?.messages.at(-2)?.content).toContain('"counterparty":"Mom","amount":"₱3,486.00"');
    expect(providerRequest?.tools.map((tool) => tool.function.name)).toContain("record_debt_payment");

    store.deleteDebt(user.id, debt.id);
    let ordinaryProviderRequest: Pick<ProviderRequest, "messages"> | undefined;
    vi.mocked(fetch).mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      ordinaryProviderRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
        name: "log_transaction", arguments: JSON.stringify({ kind: "income", category: "Other income", amount: "100", description: "Mom paid me" }),
      } }] } }] }), { headers: { "content-type": "application/json" } });
    });
    const ordinaryPaymentResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 100" }),
    }));
    const ordinaryPaymentResult = await ordinaryPaymentResponse.json();
    expect(ordinaryPaymentResult).toMatchObject({ transaction: null, debt: null });
    expect(ordinaryPaymentResult.answer).toContain("Should I record");
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(10000);
    expect(store.listDebts(user.id)).toHaveLength(0);
    expect(ordinaryProviderRequest?.messages.at(-2)?.content).toBe("Untrusted ledger data for matching only: []");

    const logDebtResponse = () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt", arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } });
    vi.mocked(fetch).mockImplementationOnce(async () => logDebtResponse());
    const uncertainResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Maybe", conversationId: ordinaryPaymentResult.conversationId }),
    }));
    const uncertainResult = await uncertainResponse.json();
    expect(uncertainResult).toMatchObject({ transaction: null, debt: null });
    expect(uncertainResult.answer).toContain("Please answer yes");

    vi.mocked(fetch).mockImplementationOnce(async () => logDebtResponse());
    const confirmationResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Yes", conversationId: ordinaryPaymentResult.conversationId }),
    }));
    const confirmationResult = await confirmationResponse.json();
    expect(confirmationResult.transaction).toMatchObject({ kind: "income", categoryName: "Other income", amountMinor: 10000 });
    expect(confirmationResult.debt).toBeNull();
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(20000);
    expect(store.listDebts(user.id)).toHaveLength(0);
  });

  it("carries the payer through an active amount clarification", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 348600 });
    const providerResponse = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("ask_clarification", { question: "What amount should I use for the repayment?" }))
      .mockResolvedValueOnce(providerResponse("log_debt", { direction: "owed_to_you", counterparty: "Mom", amount: "100" })));

    const initialResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me" }),
    }));
    const { conversationId } = await initialResponse.json();
    const followupResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "100", conversationId }),
    }));
    const result = await followupResponse.json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 10000 });
    expect(result.debt).toMatchObject({ id: debt.id, amountMinor: 338600, status: "open" });
    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(10000);
  });

  it("does not write when ordinary income is declined after a missing-debt clarification", async () => {
    const providerResponse = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Mom", amount: "100" }))
      .mockResolvedValueOnce(providerResponse("log_debt", { direction: "owed_to_you", counterparty: "Mom", amount: "100" })));

    const initialResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 100" }),
    }));
    const { conversationId } = await initialResponse.json();
    const declineResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "No", conversationId }),
    }));
    const result = await declineResponse.json();

    expect(result).toMatchObject({ transaction: null, debt: null, answer: "Okay, I won't record the money." });
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listDebts(user.id)).toHaveLength(0);
  });

  it("keeps an accepted ordinary-income choice through a later account clarification", async () => {
    const providerResponse = (name: string, args: Record<string, unknown>) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse("record_debt_payment", { counterparty: "Mom", amount: "100" }))
      .mockResolvedValueOnce(providerResponse("log_transaction", { kind: "income", category: "Other income", amount: "100", account: "Missing account" }))
      .mockResolvedValueOnce(providerResponse("log_debt", { direction: "owed_to_you", counterparty: "Mom", amount: "100", account: "Wallet" })));

    const initialResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 100" }),
    }));
    const { conversationId } = await initialResponse.json();
    const confirmationResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Yes", conversationId }),
    }));
    expect((await confirmationResponse.json()).answer).toContain("I couldn't find the account");

    const accountResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Wallet", conversationId }),
    }));
    const result = await accountResponse.json();

    expect(result.transaction).toMatchObject({ kind: "income", categoryName: "Other income", amountMinor: 10000, accountName: "Wallet" });
    expect(result.debt).toBeNull();
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(10000);
    expect(store.listDebts(user.id)).toHaveLength(0);
  });

  it("asks before updating a different person selected by the provider", async () => {
    const momDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 20000 });
    const dadDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Dad", amountMinor: 30000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Mom", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Dad paid me 100" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("Which person's open debt");
    expect(store.listDebts(user.id).find((debt) => debt.id === momDebt.id)?.amountMinor).toBe(20000);
    expect(store.listDebts(user.id).find((debt) => debt.id === dadDebt.id)?.amountMinor).toBe(30000);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it.each(["Mom paid back 100", "Mom returned 100"])("recognizes incoming repayment wording: %s", async (prompt) => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 348600 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt", arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 10000 });
    expect(result.debt).toMatchObject({ id: debt.id, amountMinor: 338600, status: "open" });
    expect(store.listDebts(user.id)).toHaveLength(1);
  });

  it.each(["Mom did not pay me 100", "Did Mom pay me 100?", "Maybe Mom paid me 100", "Did Mom pay back 100?", "Mom did not return 100"])("asks before recording uncertain repayment wording: %s", async (prompt) => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 348600 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt", arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("couldn't confirm that the payment happened");
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)?.amountMinor).toBe(348600);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("asks which debt to update when the repayment message names multiple people", async () => {
    const momDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 20000 });
    const dadDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Dad", amountMinor: 30000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Mom", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom and Dad paid me 100" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("Which person's open debt");
    expect(store.listDebts(user.id).find((debt) => debt.id === momDebt.id)?.amountMinor).toBe(20000);
    expect(store.listDebts(user.id).find((debt) => debt.id === dadDebt.id)?.amountMinor).toBe(30000);
  });

  it("matches a non-Latin counterparty without reducing another person's debt", async () => {
    const unrelatedDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "王", amountMinor: 20000 });
    const matchingDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "李", amountMinor: 348600 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "李", amount: "100" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "李 paid me 100" }),
    }));
    const result = await response.json();

    expect(result.debt).toMatchObject({ id: matchingDebt.id, amountMinor: 338600, status: "open" });
    expect(store.listDebts(user.id).find((debt) => debt.id === unrelatedDebt.id)).toMatchObject({ amountMinor: 20000, status: "open" });
  });

  it("uses the provider's validated time when the time wording is not parsed locally", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 348600 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Mom", amount: "100", time: "15:30" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 100 around half past three" }),
    }));

    expect((await response.json()).transaction.time).toBe("15:30");
  });
});
