import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { providerDisclosureHash } from "../src/lib/provider";
import { todayInManila } from "../src/lib/dates";
import { POST } from "../src/app/api/assistant/route";

type ProviderRequest = { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };

function providerTool(name: string, args: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] }), {
    headers: { "content-type": "application/json" },
  });
}
function assistantRequest(prompt: string, conversationId?: string) {
  return new Request("https://tally.test/api/assistant", {
    method: "POST",
    headers: { origin: "https://tally.test", "content-type": "application/json" },
    body: JSON.stringify({ prompt, ...(conversationId ? { conversationId } : {}) }),
  });
}
function seedDebtFinanceFacts() {
  const account = store.listAccounts(user.id)[0];
  const expenseCategory = store.listCategories(user.id).find((category) => category.type === "expense")!;
  const incomingDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Riley", amountMinor: 30_000 });
  store.recordDebtPayment(user.id, incomingDebt.id, {
    amountMinor: 12_000, description: "Riley paid me", accountId: account.id, date: "2026-10-05", time: "12:00",
  });
  const outgoingDebt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Morgan", amountMinor: 100_000 });
  store.recordDebtRepayment(user.id, outgoingDebt.id, {
    kind: "expense", amountMinor: 50_000, description: "Paid Morgan back", accountId: account.id,
    categoryId: expenseCategory.id, date: "2026-10-06", time: "12:00",
  });
  store.createTransaction(user.id, {
    kind: "expense", amountMinor: 25_000, description: "Groceries", accountId: account.id,
    categoryId: expenseCategory.id, date: "2026-10-07", time: "12:00",
  });
}
function financeQuestionResponse() {
  return providerTool("finance_question", { start: "2026-10-01", end: "2026-10-09" });
}

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

  it.each([
    ["colon", "transportation 500 at 2:35 PM on 2026-02-20", { kind: "expense", amount: "500", description: "transportation", date: "2026-02-20", time: "14:35" }, "14:35", "2026-02-20"],
    ["compact", "14 tricycle at 1130am", { kind: "expense", amount: "14", description: "tricycle", category: "Transport" }, "11:30", undefined],
  ] as const)("keeps explicitly stated transaction time in %s notation", async (_notation, prompt, providerArgs, expectedTime, expectedDate) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", providerArgs as Record<string, unknown>)));
    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    if (expectedDate) expect(result.transaction.date).toBe(expectedDate);
    expect(result.transaction.time).toBe(expectedTime);
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

describe("assistant finance reporting", () => {
  it("routes a debt repayment report to period finance facts instead of current debt balances", async () => {
    seedDebtFinanceFacts();
    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

    const response = await POST(assistantRequest("Show debt repayments this month"));
    const result = await response.json();

    expect(result.answer).toContain("Repayments received: ₱120.00");
    expect(result.answer).not.toContain("Open debts");
  });

  it("reports the user's debt repayments made instead of repayments received", async () => {
    seedDebtFinanceFacts();
    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

    const response = await POST(assistantRequest("Total debt repayments made this month"));
    const result = await response.json();

    expect(result.answer).toContain("Debt repayments made: ₱500.00");
    expect(result.answer).not.toContain("Repayments received");
  });

  it("answers a repayment amount question without treating it as an unconfirmed payment", async () => {
    seedDebtFinanceFacts();
    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

    const response = await POST(assistantRequest("How much did I repay?"));
    const result = await response.json();

    expect(result.answer).toContain("Debt repayments made: ₱500.00");
    expect(result.transaction).toBeNull();
    expect(result.debt).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(3);
  });

  it("includes spending and received repayments when a finance question asks for both", async () => {
    seedDebtFinanceFacts();
    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

    const response = await POST(assistantRequest("How much did I spend and receive in debt repayments this month?"));
    const result = await response.json();

    expect(result.answer).toContain("Total Spent: ₱750.00");
    expect(result.answer).toContain("Repayments received: ₱120.00");
  });
});

describe("assistant recurring bill capture", () => {
  it("routes a descriptive bill statement into the bill flow when the provider suggests a transaction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "500", category: "Utilities", description: "Internet",
    })));

    const response = await POST(assistantRequest("I have a TikTok Shop VXE R1 Pro bill."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("cadence");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it.each([
    ["I have a monthly Internet bill for ₱500 starting tomorrow through December 31.", "Internet"],
    ["I have a monthly TikTok Shop VXE R1 Pro bill for ₱500 starting tomorrow through December 31.", "TikTok Shop VXE R1 Pro"],
  ])("asks before updating a matching bill for '%s'", async (prompt, billName) => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    store.createBill(user.id, { name: billName, amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("update_bill", {
      name: billName, amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
    })));

    const response = await POST(assistantRequest(prompt));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("add another");
    expect(result.answer.toLowerCase()).toContain("update the existing");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toMatchObject([{ amountMinor: 2500, nextDueDate: "2026-11-09", endDate: null }]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it.each([
    "I have a question about my electricity bill.",
    "I have a question about bills.",
    "I have a quick question about bills.",
    "I have an urgent issue with my electricity bill.",
    "I have a bill question about electricity.",
    "Can you add up what I spent on my electricity bill?",
  ])("keeps '%s' in the finance question flow", async (prompt) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("finance_question", {
      start: "2026-10-01", end: "2026-10-09", category: "Utilities",
    })));

    const response = await POST(assistantRequest(prompt));
    const result = await response.json();

    expect(result.answer).toContain("Utilities");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("lets a finance question interrupt a pending bill clarification", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerTool("create_bill", { name: "Internet" }))
      .mockResolvedValueOnce(providerTool("finance_question", {
        start: "2026-10-01", end: "2026-10-09", category: "Utilities",
      })));

    const first = await POST(assistantRequest("I have an Internet bill."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("How much did I spend on utilities this month?", conversationId));
    const result = await second.json();

    expect(result.answer).toContain("Utilities");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("uses user-stated amount, cadence, and dates and defaults the account and expense category", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "tiktok shop vxe r1 pro", amount: "900", frequency: "yearly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
      account: "Missing account", category: "Food",
    })));

    const response = await POST(assistantRequest("I have a bill on TikTok Shop about VXE R1 Pro. It is ₱1,234.50 weekly, started today, and ends December 15."));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ transaction: null, debt: null, undoUntil: null, bill: {
      name: "TikTok Shop VXE R1 Pro", amountMinor: 123450, frequency: "weekly", endDate: "2026-12-15",
      accountName: "Wallet", categoryName: "Shopping",
    } });
    expect(result.answer).toContain("Oct 9");
    expect(result.answer).toContain("Dec 15");
    expect(result.answer).toContain("Wallet");
    expect(result.answer).toContain("Shopping");
    expect(store.listTransactions(user.id, { start: "2026-10-09", end: "2026-10-09" }, 10)).toMatchObject([{ kind: "expense", amountMinor: 123450, description: "TikTok Shop VXE R1 Pro" }]);
  });

  it("asks for all missing bill details together without writing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "What amount should I use?" })));

    const response = await POST(assistantRequest("I have a bill on TikTok Shop about VXE R1 Pro."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("amount");
    expect(result.answer.toLowerCase()).toContain("cadence");
    expect(result.answer.toLowerCase()).toContain("first due date");
    expect(result.answer.toLowerCase()).toContain("exact end date");
    expect(result).toMatchObject({ bill: null, transaction: null, debt: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("asks for an omitted first due date instead of using today", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-11-30",
    })));

    const response = await POST(assistantRequest("I have a monthly Internet bill for ₱500 that ends November 30."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("first due date");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("does not use one bare date reply for both missing schedule dates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-20", endDate: "2026-10-20",
    })));

    const first = await POST(assistantRequest("I have a monthly Internet bill for ₱500."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("October 20", conversationId));
    const result = await second.json();

    expect(result.answer.toLowerCase()).toContain("first due date");
    expect(result.answer.toLowerCase()).toContain("exact end date");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
  });

  it("uses two unlabeled dates in order when both schedule dates were requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-20", endDate: "2026-12-15",
    })));

    const first = await POST(assistantRequest("I have a monthly Internet bill."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("500 monthly, October 20, December 15", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ amountMinor: 50000, nextDueDate: "2026-10-20", endDate: "2026-12-15" });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("accepts a corrected first due date after rejecting a past date", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
    })));

    const first = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting yesterday through December 31."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("October 10", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ name: "Internet", nextDueDate: "2026-10-10" });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("asks for an exact day when the end date names only a month", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-12-31",
    })));

    const response = await POST(assistantRequest("I have a monthly Internet bill for ₱500 starting today that ends in December."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("exact day");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("uses a day-only reply to complete an end month clarification", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-12-31",
    })));

    const first = await POST(assistantRequest("I have a monthly Internet bill for ₱500 starting today that ends in December."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("15", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ name: "Internet", endDate: "2026-12-15" });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("uses the nearest upcoming year for a month and day without a year", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-01-15",
    })));

    const response = await POST(assistantRequest("I have a monthly Internet bill for ₱500 starting today that ends January 15."));
    const result = await response.json();

    expect(result.bill).toMatchObject({ endDate: "2027-01-15" });
  });

  it("asks before creating when an exact normalized active name already exists", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Shopping")!;
    const existing = store.createBill(user.id, { name: "TikTok Shop - VXE R1 Pro", amountMinor: 10000, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2027-12-31", accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "VXE R1 Pro", amount: "500", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-12-15",
    })));

    const response = await POST(assistantRequest("I have a bill on TikTok Shop about VXE R1 Pro for ₱500 monthly starting today and ending December 15."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("add another");
    expect(result.answer.toLowerCase()).toContain("update");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toHaveLength(1);
    expect(store.listBills(user.id)[0].id).toBe(existing.id);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("updates only the stated amount and leaves posted transactions unchanged", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2027-12-31", accountId: account.id, categoryId: category.id });
    store.processDueBills("2026-10-09");
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("update_bill", {
      name: "Internet", amount: "999", frequency: "yearly", nextDueDate: "2026-12-01", endDate: "2026-12-31",
      account: "Missing account", category: "Food",
    })));

    const response = await POST(assistantRequest("Update the Internet bill amount to ₱30."));
    const result = await response.json();

    expect(result.bill).toMatchObject({ id: bill.id, amountMinor: 3000, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2027-12-31", accountId: account.id, categoryId: category.id });
    expect(store.listTransactions(user.id, { start: "2026-10-09", end: "2026-10-09" }, 10)).toMatchObject([{ amountMinor: 2500, description: "Internet" }]);
  });

  it("clears a bill end date when the user explicitly asks to remove it", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2027-12-31", accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("update_bill", { name: "Internet", endDate: null })));

    const response = await POST(assistantRequest("Remove the end date from the Internet bill."));
    const result = await response.json();

    expect(result.bill).toMatchObject({ id: bill.id, endDate: null });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("clears an end date when the provider selects create_bill for a removal request", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const bill = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2027-12-31", accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", { name: "Internet", amount: "2500", endDate: null })));

    const response = await POST(assistantRequest("Remove the end date from the Internet bill."));
    const result = await response.json();

    expect(result.bill).toMatchObject({ id: bill.id, endDate: null });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("creates a second matching schedule only after the user chooses add another", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
    })));

    const first = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting tomorrow through December 31."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("Add another", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ name: "Internet", amountMinor: 50000, endDate: "2026-12-31" });
    expect(store.listBills(user.id)).toHaveLength(2);
  });

  it("updates a matching bill only after the user chooses update", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const existing = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2027-12-31", accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerTool("create_bill", { name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31" }))
      .mockResolvedValueOnce(providerTool("update_bill", { name: "Internet", amount: "500" })));

    const first = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting tomorrow through December 31."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("Update the existing one", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ id: existing.id, amountMinor: 50000, frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31" });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("asks which exact active schedule to update when names match more than once", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    store.createBill(user.id, { name: "Internet", amountMinor: 3500, frequency: "monthly", nextDueDate: "2026-12-09", endDate: null, accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("update_bill", { name: "Internet", amount: "30" })));

    const response = await POST(assistantRequest("Update the Internet bill amount to ₱30."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toContain("which schedule");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id).map((bill) => bill.amountMinor)).toEqual([2500, 3500]);
  });

  it("requires a unique choice when matching schedules share a next due date", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const firstBill = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    const secondBill = store.createBill(user.id, { name: "Internet", amountMinor: 3500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("update_bill", { name: "Internet", amount: "30" })));

    const first = await POST(assistantRequest("Update the Internet bill amount to ₱30."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("2026-11-09", conversationId));
    const secondResult = await second.json();

    expect(secondResult.answer.toLowerCase()).toContain("which schedule");
    expect(secondResult).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id).map((bill) => bill.amountMinor)).toEqual([2500, 3500]);

    const third = await POST(assistantRequest("2", conversationId));
    const result = await third.json();

    expect(result.bill).toMatchObject({ id: secondBill.id, amountMinor: 3000 });
    expect(store.listBills(user.id).find((bill) => bill.id === firstBill.id)?.amountMinor).toBe(2500);
  });

  it("asks for the user's bill name when it cannot be extracted before duplicate matching", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
    })));

    const first = await POST(assistantRequest("I have a recurring bill."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("Internet", conversationId));
    const result = await second.json();

    expect(result.answer.toLowerCase()).toContain("add another");
    expect(result.answer.toLowerCase()).toContain("update");
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("allows creating a new schedule when only an archived name match exists", async () => {
    const account = store.listAccounts(user.id)[0];
    const category = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    const archived = store.createBill(user.id, { name: "Internet", amountMinor: 2500, frequency: "monthly", nextDueDate: "2026-11-09", endDate: null, accountId: account.id, categoryId: category.id });
    store.archiveBill(user.id, archived.id);
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
    })));

    const response = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting tomorrow through December 31."));
    const result = await response.json();

    expect(result.bill).toMatchObject({ name: "Internet", amountMinor: 50000, endDate: "2026-12-31" });
    expect(store.listBills(user.id)).toHaveLength(2);
    expect(store.listBills(user.id).find((bill) => bill.id === archived.id)?.archivedAt).toBeTruthy();
  });

  it.each([
    ["an invalid amount", "I have an Internet bill for ₱0 monthly starting tomorrow through December 31."],
    ["an invalid first due date", "I have an Internet bill for ₱500 monthly starting February 30, 2026 through December 31, 2026."],
    ["a past first due date", "I have an Internet bill for ₱500 monthly starting yesterday through December 31."],
  ])("asks before saving when the prompt contains %s", async (_case, prompt) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31",
    })));

    const response = await POST(assistantRequest(prompt));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toMatch(/valid|positive|today or later/);
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });

  it("asks when the requested account or category cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31", account: "Wallet", category: "Utilities",
    })));

    const response = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting tomorrow through December 31 using my Rainy Day account, category Special."));
    const result = await response.json();

    expect(result.answer.toLowerCase()).toMatch(/account|category/);
    expect(result).toMatchObject({ bill: null, transaction: null });
    expect(store.listBills(user.id)).toEqual([]);
  });

  it("uses a valid account and category supplied in the clarification reply", async () => {
    const wallet = store.listAccounts(user.id)[0];
    const utilities = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31", account: "Rainy Day", category: "Special",
    })));

    const first = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting tomorrow through December 31 using my Rainy Day account, category Special."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("Wallet, Utilities", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ name: "Internet", accountId: wallet.id, categoryId: utilities.id });
    expect(store.listBills(user.id)).toHaveLength(1);
  });

  it("reports a retry warning when a due-today expense cannot be posted", async () => {
    vi.spyOn(store, "processDueBills").mockImplementation(() => { throw new Error("temporary posting failure"); });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-12-31",
    })));

    const response = await POST(assistantRequest("I have an Internet bill for ₱500 monthly starting today through December 31."));
    const result = await response.json();

    expect(result.bill).toMatchObject({ name: "Internet", nextDueDate: "2026-10-09" });
    expect(result.postingWarning).toContain("retry");
    expect(result.answer).toContain(result.postingWarning);
    expect(store.listTransactions(user.id, undefined, 10)).toEqual([]);
  });
});

describe("assistant debt capture", () => {
  it.each([["Ari paid me", "200"], ["Ari paid me; my balance was ₱500", "500"]])("does not use a provider-inferred repayment amount when the user omitted it: %s", async (prompt, amount) => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 100000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("What amount");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 100000, status: "open" }]);
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

  it("uses the amount tied to a repayment instead of an unrelated currency amount", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 100000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Ari", amount: "500" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ari paid me 100; my balance was ₱500" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("re-enter the repayment amount");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 100000, status: "open" }]);
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

  it.each(["Show all debts and total amount", "Show all debts including settled and total amount"])("includes open and settled records for all-debt wording: %s", async (prompt) => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ari", amountMinor: 20000 });
    const settledDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mika", amountMinor: 10000 });
    store.recordDebtPayment(user.id, settledDebt.id, {
      amountMinor: 10000, description: "Mika paid me", accountId: store.listAccounts(user.id)[0].id,
      date: "2026-10-13", time: "12:00",
    });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
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
      amountMinor: 20000, description: "Ari paid me", accountId: store.listAccounts(user.id)[0].id,
      date: "2026-10-09", time: "12:00",
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

    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, categoryName: null, undoUntil: null });
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

    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, categoryName: null, undoUntil: null });
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

    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, accountName: "Wallet", categoryName: null, undoUntil: null });
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

  it("keeps an owed-to-you statement debt-only unless the user asks for a transaction", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27" }),
    }));
    const result = await response.json();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      debt: { direction: "owed_to_you", counterparty: "Mom", amountMinor: 2_700, status: "open" },
      transaction: null, undoUntil: null,
    });
    expect(result.answer).toContain("Added it to Debts only");
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("uses the named expense details for an owed-to-you debt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27", note: "Jollibee", category: "Food", account: "Wallet", date: "2026-10-08", time: "15:30", recordTransaction: false }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27 for Jollibee from Wallet on 2026-10-08 at 3:30 PM; add the advance to Transactions" }),
    }));
    const result = await response.json();

    expect(result.transaction).toMatchObject({ kind: "expense", amountMinor: 2_700, categoryName: "Food", accountName: "Wallet", date: "2026-10-08", time: "15:30", undoUntil: null });
    expect(result.transaction.description).toContain("Jollibee");
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(-2_700);
  });

  it("keeps the debt due date separate from the advance transaction date", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27", dueDate: "2026-11-15" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Please log that Mom owes me 27 for lunch and add the expense to Transactions, repayable by 2026-11-15" }),
    }));
    const result = await response.json();

    expect(result.debt).toMatchObject({ dueDate: "2026-11-15" });
    expect(result.transaction.date).toBe(todayInManila());
  });

  it("uses the newest explicit account and category after a provider clarification", async () => {
    store.createAccount(user.id, { name: "Bank", type: "bank", openingMinor: 0 });
    const providerResponse = () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27", category: "Housing", account: "Missing account" }),
    } }] } }] }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(providerResponse()).mockResolvedValueOnce(providerResponse()));

    const firstResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Please record that Mom owes me 27 for Housing and add the expense to Transactions" }),
    }));
    const firstResult = await firstResponse.json();
    expect(firstResult.debt).toBeNull();
    expect(firstResult.answer).toContain("couldn't find the account");

    const followupResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Use Bank and Food", conversationId: firstResult.conversationId }),
    }));
    const result = await followupResponse.json();

    expect(result.transaction).toMatchObject({ accountName: "Bank", categoryName: "Food", amountMinor: 2_700 });
    expect(result.debt).toMatchObject({ counterparty: "Mom", amountMinor: 2_700 });
    expect(store.listAccounts(user.id).map(({ name, balanceMinor }) => [name, balanceMinor])).toEqual([["Wallet", 0], ["Bank", -2_700]]);
  });

  it.each([
    ["direction", { direction: "you_owe", counterparty: "Mom", amount: "27" }],
    ["counterparty", { direction: "owed_to_you", counterparty: "Dad", amount: "27" }],
  ])("asks before writing when the provider selects a different debt %s", async (_mismatch, args) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt", arguments: JSON.stringify(args),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Please record that Mom owes me 27 for lunch and add it to Transactions" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null, undoUntil: null });
    expect(store.listDebts(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it.each(["Maybe Mom owes me 27 for lunch", "Mom doesn't owe me 27 for lunch", "Mom owes me nothing"]) (
    "asks without writing for uncertain or negated debt wording: %s", async (prompt) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
        name: "log_debt", arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27" }),
      } }] } }] }), { headers: { "content-type": "application/json" } })));

      const response = await POST(new Request("https://tally.test/api/assistant", {
        method: "POST",
        headers: { origin: "https://tally.test", "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      }));
      const result = await response.json();

      expect(result).toMatchObject({ transaction: null, debt: null, undoUntil: null });
      expect(store.listDebts(user.id)).toEqual([]);
      expect(store.listTransactions(user.id)).toEqual([]);
      expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    },
  );

  it.each([
    { label: "an older debt with a due date shares its timestamp", older: { dueDate: "2026-10-20" }, newerElsewhere: false },
    { label: "a newer debt for the same person is created elsewhere", older: {}, newerElsewhere: true },
  ])("adds the conversation's own debt to Transactions when $label", async ({ older, newerElsewhere }) => {
    const other = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 22_300, ...older });
    const debtCall = { direction: "owed_to_you", counterparty: "Mom", amount: "223" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerTool("log_debt", debtCall))
      .mockResolvedValueOnce(providerTool("log_debt", { ...debtCall, recordTransaction: true })));

    const first = await (await POST(assistantRequest("mom owes me 223 for moveit transpo"))).json();
    if (newerElsewhere) store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 22_300 });
    const second = await (await POST(assistantRequest("add it to transactions", first.conversationId))).json();

    expect(second.answer).toContain("Added to Debts and Transactions");
    expect(second.debt.id).toBe(first.debt.id);
    expect(second.debt.id).not.toBe(other.id);
    expect(store.listTransactions(user.id)).toHaveLength(1);
  });

  it("keeps debts the user owes as debt-only records", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "i owe ate liyah 27" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 2_700 }, transaction: null, undoUntil: null });
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it.each([
    { optOutMessage: "don't add it to transactions", providerChoice: false },
    { optOutMessage: "don't add it to transactions", providerChoice: true },
    { optOutMessage: "don't want a transaction", providerChoice: true },
    { optOutMessage: "without recording it as an expense", providerChoice: true },
  ])("honors the debt-only request '$optOutMessage' over provider choice $providerChoice", async ({ optOutMessage, providerChoice }) => {
    database.prepare("DELETE FROM financial_accounts WHERE user_id=?").run(user.id);
    database.prepare("DELETE FROM categories WHERE user_id=? AND type='expense'").run(user.id);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27", recordTransaction: providerChoice }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: `Mom owes me 27, but ${optOutMessage}.` }),
    }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      debt: { direction: "owed_to_you", counterparty: "Mom", amountMinor: 2_700, status: "open", activity: [] },
      transaction: null, undoUntil: null,
    });
    expect(result.answer).toContain("Added it to Debts only");
    expect(store.listAccounts(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it.each(["account", "expense category"]) ("does not default to debt-only when the required %s setup is missing", async (missingSetup) => {
    if (missingSetup === "account") database.prepare("DELETE FROM financial_accounts WHERE user_id=?").run(user.id);
    else database.prepare("DELETE FROM categories WHERE user_id=? AND type='expense'").run(user.id);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Please record that Mom owes me 27 for lunch and add the expense to Transactions" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: null, undoUntil: null });
    expect(store.listDebts(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listAccounts(user.id).reduce((sum, account) => sum + account.balanceMinor, 0)).toBe(0);
  });

  it("leaves configured account balances unchanged for an explicit debt-only opt-out", async () => {
    store.createAccount(user.id, { name: "Savings", type: "bank", openingMinor: 5_000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27", recordTransaction: false }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27, but don't add it to transactions" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: { direction: "owed_to_you", activity: [] }, transaction: null });
    expect(store.listAccounts(user.id).map(({ name, balanceMinor }) => [name, balanceMinor])).toEqual([["Wallet", 0], ["Savings", 5_000]]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("keeps a debt-only statement debt-only when the provider asks for a transaction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "log_debt",
      arguments: JSON.stringify({ direction: "owed_to_you", counterparty: "Mom", amount: "27", recordTransaction: false }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Please record that Mom owes me 27 for lunch" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: { direction: "owed_to_you", activity: [] }, transaction: null, undoUntil: null });
    expect(result.answer).toContain("Added it to Debts only");
    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("records a borrowed amount as income only when the user explicitly asks for a transaction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", {
      direction: "you_owe", counterparty: "Ate Liyah", amount: "100", note: "food", recordTransaction: true,
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I owe Ate Liyah 100 for food; add that to Transactions" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({
      debt: { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 10_000 },
      transaction: { kind: "income", amountMinor: 10_000, categoryName: "Other income", undoUntil: null },
    });
    expect(result.transaction.description.toLowerCase()).toContain("food");
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(10_000);
  });

  it.each([
    { prompt: "I borrowed 100 from Mom and add it to Transactions", direction: "you_owe", kind: "income", sign: 10_000 },
    { prompt: "I fronted 100 for Mom and record the expense", direction: "owed_to_you", kind: "expense", sign: -10_000 },
  ])("links an explicit transaction for '$prompt' even when the provider selects log_transaction", async ({ prompt, direction, kind, sign }) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind, amount: "100", description: "Money for Mom",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    expect(result.debt).toMatchObject({ direction, counterparty: "Mom", amountMinor: 10_000, activity: [{ kind, amountMinor: sign }] });
    expect(result.transaction).toMatchObject({ kind, amountMinor: 10_000, undoUntil: null });
    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(store.listTransactions(user.id)).toHaveLength(1);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(sign);
  });

  it("treats an outgoing payment as a linked expense when the user owes that person", async () => {
    const debt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 10_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "50", description: "Paid Ate Liyah",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I paid Ate Liyah 50" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({
      debt: { id: debt.id, direction: "you_owe", amountMinor: 5_000, status: "open" },
      transaction: { kind: "expense", amountMinor: 5_000, categoryName: "Other", undoUntil: null },
    });
    expect(store.listDebts(user.id)[0].activity).toMatchObject([{ kind: "expense", amountMinor: -5_000 }]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(-5_000);
  });

  it("captures the stated amount when the user says 'I repaid 100 to Mom'", async () => {
    const debt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_repayment", {
      counterparty: "Mom", amount: "100", description: "Debt repayment",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I repaid 100 to Mom" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({
      debt: { id: debt.id, direction: "you_owe", amountMinor: 10_000, status: "open" },
      transaction: { kind: "expense", amountMinor: 10_000, undoUntil: null },
    });
  });

  it("asks who the user repaid when an amount-only repayment could match an open debt", async () => {
    const debt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "100", description: "Debt repayment",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I repaid 100" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: null, undoUntil: null });
    expect(result.answer).toContain("Who did you repay");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20_000, status: "open" }]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("does not turn a negated outgoing payment into an expense", async () => {
    const debt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "100", description: "Paid Mom",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I haven't paid Mom 100" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null, undoUntil: null });
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20_000, status: "open" }]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("does not capture a relative date as the counterparty in a borrowed debt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "income", amount: "100", description: "Borrowed funds",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I borrowed 100 from Mom yesterday and add it to Transactions" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({
      debt: { direction: "you_owe", counterparty: "Mom", amountMinor: 10_000 },
      transaction: { kind: "income", amountMinor: 10_000, date: "2026-10-08" },
    });
  });

  it("does not capture a relative date as part of a fronted-money question", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "100", description: "Fronted for Mom",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I fronted 100 for Mom?" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: null, undoUntil: null });
    expect(store.listDebts(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("carries the payment amount through a payee clarification", async () => {
    const momDebt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    const dadDebt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Dad", amountMinor: 30_000 });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" }))
      .mockResolvedValueOnce(providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" })));

    const first = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I paid Mom and Dad 100" }),
    }));
    const firstResult = await first.json();
    expect(firstResult.answer).toContain("Which person's open debt");

    const followup = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom", conversationId: firstResult.conversationId }),
    }));
    const result = await followup.json();

    expect(result.transaction).toMatchObject({ kind: "expense", amountMinor: 10_000 });
    expect(result.debt).toMatchObject({ id: momDebt.id, amountMinor: 10_000, status: "open" });
    expect(store.listDebts(user.id).find((item) => item.id === dadDebt.id)).toMatchObject({ amountMinor: 30_000, status: "open" });
  });

  it("asks when the provider amount differs from an outgoing payment the user stated", async () => {
    const debt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Ate Liyah", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "500", description: "Paid Ate Liyah",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I paid Ate Liyah 50" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("I understood ₱50.00");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 100_000, status: "open" }]);
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("records a completed outgoing payment as an ordinary expense when no debt matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "50", description: "Paid Ate Liyah",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I paid Ate Liyah 50" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: { kind: "expense", amountMinor: 5_000 } });
    expect(store.listDebts(user.id)).toEqual([]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(-5_000);
  });

  it("does not log an expense when the user asks whether they paid", async () => {
    const debt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "100", description: "Paid Mom",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Did I pay Mom 100" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null, undoUntil: null });
    expect(result.answer).toContain("I didn't record anything");
    expect(store.listDebts(user.id)).toMatchObject([{ id: debt.id, amountMinor: 20_000, status: "open" }]);
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("does not match Ann to a payment from Ann-Marie", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ann", amountMinor: 10_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "income", amount: "20", description: "Ann-Marie paid me",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ann-Marie paid me 20" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: null });
    expect(result.answer).toContain("couldn't find an open debt");
    expect(store.listDebts(user.id)[0].amountMinor).toBe(10_000);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("matches a hyphenated payer without collapsing it into a space-separated name", async () => {
    const spaceName = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Jean Luc", amountMinor: 20_000 });
    const hyphenName = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Jean-Luc", amountMinor: 30_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "income", amount: "100", description: "Jean-Luc paid me",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Jean-Luc paid me 100" }),
    }));
    const result = await response.json();

    expect(result.debt).toMatchObject({ id: hyphenName.id, amountMinor: 20_000, status: "open" });
    expect(store.listDebts(user.id).find((item) => item.id === spaceName.id)).toMatchObject({ amountMinor: 20_000, status: "open" });
  });

  it("keeps an explicit debt-only statement from becoming a transaction when the provider selects log_transaction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", {
      kind: "expense", amount: "27", description: "Owed by Mom",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27, keep it debt-only" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: { direction: "owed_to_you", counterparty: "Mom", activity: [] }, transaction: null });
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("does not let the phrase 'no transaction yet' opt into recording an advance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", {
      direction: "owed_to_you", counterparty: "Mom", amount: "27", recordTransaction: true,
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27, no transaction yet" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: { direction: "owed_to_you", activity: [] }, transaction: null });
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("uses an explicitly named account and category only when they exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", {
      direction: "owed_to_you", counterparty: "Mom", amount: "27", category: "Other", account: "Wallet",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27, add an expense using the Vacation category" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: null });
    expect(result.answer).toMatch(/category/i);
    expect(store.listDebts(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("accepts a clear confirmation after asking about an uncertain debt", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerTool("log_debt", { direction: "owed_to_you", counterparty: "Mom", amount: "27" }))
      .mockResolvedValueOnce(providerTool("log_debt", { direction: "owed_to_you", counterparty: "Mom", amount: "27" })));

    const firstResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Maybe Mom owes me 27" }),
    }));
    const firstResult = await firstResponse.json();
    expect(firstResult.debt).toBeNull();

    const confirmationResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Yes, that's confirmed", conversationId: firstResult.conversationId }),
    }));
    const result = await confirmationResponse.json();

    expect(result.debt).toMatchObject({ direction: "owed_to_you", counterparty: "Mom", amountMinor: 2_700 });
    expect(result.transaction).toBeNull();
  });

  it("does not treat a question mark alone as uncertainty when the debt is stated as fact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", {
      direction: "owed_to_you", counterparty: "Mom", amount: "27",
    })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27 for lunch, just confirming the note?" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: { direction: "owed_to_you", amountMinor: 2_700 }, transaction: null });
  });

  it.each(["Does Mom owe me 100?", "Mom owes me 100?"]) ("does not create a debt from a question: %s", async (prompt) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "Is this a confirmed debt?" })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ debt: null, transaction: null, undoUntil: null });
    expect(store.listDebts(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("adds a transaction to the same debt when the user opts in during the active follow-up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", {
      direction: "owed_to_you", counterparty: "Mom", amount: "27", note: "Jollibee", recordTransaction: true,
    })));

    const firstResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom owes me 27" }),
    }));
    const firstResult = await firstResponse.json();
    expect(store.getConversation(user.id, firstResult.conversationId)?.messages.at(-1)?.needsFollowup).toBe(true);

    const followupResponse = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Add it to Transactions; it was Jollibee", conversationId: firstResult.conversationId }),
    }));
    const result = await followupResponse.json();

    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(result.debt).toMatchObject({ id: firstResult.debt.id, activity: [{ kind: "expense", categoryName: "Food" }] });
    expect(result.transaction).toMatchObject({ kind: "expense", amountMinor: 2_700, categoryName: "Food" });
    expect(result.transaction.description).toContain("Jollibee");
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(-2_700);
  });

  it("applies a repayment to the oldest open debt for the exact payer", async () => {
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

    expect(result.debt).toMatchObject({ id: earlierDebt.id, amountMinor: 298600, status: "open" });
    expect(store.listDebts(user.id).find((debt) => debt.id === jacketDebt.id)).toMatchObject({ amountMinor: 50000, status: "open" });
    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 50000, categoryName: null, undoUntil: null });
    expect(providerRequest?.messages.at(-2)?.content).toBe('Untrusted ledger data for matching only: {"owed_to_you":[{"counterparty":"Mom","amount":"₱3,486.00"},{"counterparty":"Mom","amount":"₱500.00"}],"you_owe":[]}');
  });

  it("asks before applying a payment larger than the oldest open debt for the payer", async () => {
    const oldestDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 50000, note: "Older loan" });
    const newerDebt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 400000, note: "Newer loan" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
      name: "record_debt_payment", arguments: JSON.stringify({ counterparty: "Mom", amount: "1000" }),
    } }] } }] }), { headers: { "content-type": "application/json" } })));

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST",
      headers: { origin: "https://tally.test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Mom paid me 1000 for the newer loan" }),
    }));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null });
    expect(result.answer).toContain("more than");
    expect(store.listDebts(user.id).find((debt) => debt.id === oldestDebt.id)).toMatchObject({ amountMinor: 50000, status: "open", activity: [] });
    expect(store.listDebts(user.id).find((debt) => debt.id === newerDebt.id)).toMatchObject({ amountMinor: 400000, status: "open", activity: [] });
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
  });

  it("records a repayment separately from income and reduces the matching debt", async () => {
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

    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, accountName: account.name, categoryName: null, description: "Mom paid me" });
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
    expect(ordinaryProviderRequest?.messages.at(-2)?.content).toBe('Untrusted ledger data for matching only: {"owed_to_you":[],"you_owe":[]}');

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

    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, categoryName: null, undoUntil: null });
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

  it.each([
    ["uncertain gave back", "Maybe Ana gave back ₱500 for the loan"],
    ["negated settled", "Ana did not settle ₱500 of her loan"],
    ["hadn't settled", "Ana hadn't settled ₱500 of her loan"],
    ["hadn't paid back", "Ana hadn't paid me back ₱500"],
    ["curly-apostrophe wasn't paid back", "Ana wasn’t able to say she paid me back ₱500"],
  ] as const)("does not record %s repayment wording", async (_wording, prompt) => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })));

    const response = await POST(assistantRequest(prompt));
    const result = await response.json();

    expect(result).toMatchObject({ transaction: null, debt: null, undoUntil: null });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)?.amountMinor).toBe(100000);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it.each(["Mom paid back 100", "Mom returned 100", "Mom paid me back ₱100"])("recognizes incoming repayment wording: %s", async (prompt) => {
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

    expect(result.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 10000, categoryName: null, undoUntil: null });
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
