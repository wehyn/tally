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

  it("uses an amount and an account supplied together in one clarification reply", async () => {
    const wallet = store.listAccounts(user.id)[0];
    const utilities = store.listCategories(user.id).find((item) => item.name === "Utilities")!;
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-31", account: "Nope", category: "Utilities",
    })));

    const first = await POST(assistantRequest("I have an Internet bill monthly starting tomorrow through December 31 using my Nope account, category Utilities."));
    const { conversationId } = await first.json();
    const second = await POST(assistantRequest("Wallet, 500", conversationId));
    const result = await second.json();

    expect(result.bill).toMatchObject({ name: "Internet", amountMinor: 50000, accountId: wallet.id, categoryId: utilities.id });
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

  it("asks which debt when the conversation's debt was deleted", async () => {
    const other = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Mom", amountMinor: 22_300 });
    const debtCall = { direction: "owed_to_you", counterparty: "Mom", amount: "223" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerTool("log_debt", debtCall))
      .mockResolvedValueOnce(providerTool("log_debt", { ...debtCall, recordTransaction: true })));

    const first = await (await POST(assistantRequest("mom owes me 223 for moveit transpo"))).json();
    store.deleteDebt(user.id, first.debt.id);
    const second = await (await POST(assistantRequest("add it to transactions", first.conversationId))).json();

    expect(second).toMatchObject({ transaction: null, debt: null, undoUntil: null });
    expect(second.answer).toContain("I couldn't find that open debt. Which debt do you mean?");
    expect(store.listDebts(user.id)).toEqual([other]);
    expect(store.listTransactions(user.id)).toEqual([]);
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
    expect(store.getConversation(user.id, firstResult.conversationId)?.messages.at(-1)?.followup).toBe("debt_transaction");

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

describe("assistant turn commit", () => {
  async function askAnaPaidMe() {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const asked = await (await POST(assistantRequest("Ana paid me"))).json();
    expect(asked.answer).toBe("What amount should I use for the repayment?");
    return { debt, conversationId: asked.conversationId as string };
  }
  const amountReask = "What amount should I use for the repayment? Reply with the amount, or say cancel to drop this.";
  const incomeReask = "Please answer yes if you want me to record this as ordinary income, or no to leave it unrecorded. Or say cancel to drop this.";
  async function askZedPaidMe() {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Zed", amount: "500" })));
    const asked = await (await POST(assistantRequest("Zed paid me 500"))).json();
    expect(asked.answer).toContain("ordinary income");
    return asked.conversationId as string;
  }
  function sentTo(call: unknown) {
    return (JSON.parse(String((call as [string, RequestInit])[1].body)) as ProviderRequest).messages.map((message) => message.content);
  }
  // A model call that waits for release(), so a test decides which turn commits first.
  function gatedProvider(answer: () => Response) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = vi.fn(async () => { await gate; return answer(); });
    vi.stubGlobal("fetch", provider);
    return { release, waitForCalls: (count: number) => vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(count)) };
  }
  const conversationChanged = "Your conversation changed while this ran. Send that again.";
  const storedTexts = (conversationId: string) => store.getConversation(user.id, conversationId)!.messages.map((message) => `${message.role}: ${message.content}`);

  it("writes a repayment once when the same answer is sent twice while the first is still waiting on the model", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    const model = gatedProvider(() => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const first = POST(assistantRequest("500", conversationId));
    const second = POST(assistantRequest("500", conversationId));
    await model.waitForCalls(2);
    model.release();
    const [saved, repeated] = await Promise.all([first, second]);

    expect(saved.status).toBe(200);
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toEqual({ error: conversationChanged });
    expect(store.listTransactions(user.id).filter((transaction) => transaction.kind === "debt_repayment")).toHaveLength(1);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(50_000);
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000, status: "open" });
    expect(storedTexts(conversationId).filter((text) => text === "user: 500")).toHaveLength(1);
  });

  it("drops a late answer when the question was cancelled while the model call was running", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    const model = gatedProvider(() => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    const late = POST(assistantRequest("500", conversationId));
    await model.waitForCalls(1);
    const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    model.release();
    const response = await late;

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: conversationChanged });
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
    expect(storedTexts(conversationId)).toEqual([
      "user: Ana paid me", "assistant: What amount should I use for the repayment?",
      "user: cancel", "assistant: Okay, I dropped that question. Nothing was recorded.",
    ]);
  });

  it("keeps the pending question and writes once when the model call fails and the answer is sent again", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    expect((await POST(assistantRequest("500", conversationId))).status).toBe(400);
    expect(storedTexts(conversationId)).toHaveLength(2);

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })));
    const retried = await POST(assistantRequest("500", conversationId));

    expect(retried.status).toBe(200);
    expect(store.listTransactions(user.id)).toHaveLength(1);
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000, status: "open" });
  });

  it("lets turns in different chats run at the same time", async () => {
    const first = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "What would you like to record?" })));
    const other = await (await POST(assistantRequest("hello"))).json();
    const model = gatedProvider(() => providerTool("ask_clarification", { question: "Anything else?" }));
    const inFirst = POST(assistantRequest("hello again", first.conversationId));
    const inOther = POST(assistantRequest("hello again", other.conversationId));
    await model.waitForCalls(2);
    model.release();

    expect([(await inFirst).status, (await inOther).status]).toEqual([200, 200]);
  });

  it("refuses a first turn in an empty chat that gained a message during the model call", async () => {
    const conversationId = store.createConversation(user.id, "Empty");
    const model = gatedProvider(() => providerTool("log_transaction", { amount: "250", description: "lunch", kind: "expense", category: "Food" }));
    const turn = POST(assistantRequest("Jollibee lunch 250", conversationId));
    await model.waitForCalls(1);
    store.addMessage(user.id, conversationId, "assistant", "Hello");
    model.release();
    const response = await turn;

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: conversationChanged });
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(storedTexts(conversationId)).toEqual(["assistant: Hello"]);
  });

  it("saves nothing when the chat is deleted during the model call, so a retry saves once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "What else?" })));
    const started = await (await POST(assistantRequest("hello"))).json();

    vi.stubGlobal("fetch", vi.fn(async () => {
      store.deleteConversation(user.id, started.conversationId);
      return providerTool("log_transaction", { amount: "250", description: "lunch", kind: "expense", category: "Food" });
    }));
    const failed = await POST(assistantRequest("Jollibee lunch 250", started.conversationId));
    expect(failed.status).toBe(404);
    expect(store.listTransactions(user.id)).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "250", description: "lunch", kind: "expense", category: "Food" })));
    const retried = await POST(assistantRequest("Jollibee lunch 250"));
    expect(retried.status).toBe(200);
    expect(store.listTransactions(user.id)).toHaveLength(1);
  });

  it("saves nothing when the assistant is turned off during the model call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      store.setAssistantConsent(user.id, null);
      return providerTool("log_transaction", { amount: "250", description: "lunch", kind: "expense", category: "Food" });
    }));
    const response = await POST(assistantRequest("Jollibee lunch 250"));

    expect(response.status).toBe(403);
    expect(store.listTransactions(user.id)).toHaveLength(0);
  });

  it("refuses a local debt-list turn when consent is withdrawn while the request body streams", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        store.setAssistantConsent(user.id, null);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ prompt: "List my debts" })));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" }, body, ...{ duplex: "half" },
    }));

    expect(response.status).toBe(403);
    expect(store.listConversations(user.id)).toHaveLength(0);
  });

  it("keeps today relative to when the request arrived when the answer comes after midnight", async () => {
    vi.setSystemTime(new Date("2026-10-09T15:59:59.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => {
      vi.setSystemTime(new Date("2026-10-09T16:00:01.000Z"));
      return providerTool("ask_clarification", { question: "How much was lunch?" });
    }));
    const asked = await (await POST(assistantRequest("lunch today"))).json();

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "250", category: "Food", description: "lunch" })));
    const result = await (await POST(assistantRequest("250", asked.conversationId))).json();

    expect(result.transaction.date).toBe("2026-10-09");
    const stored = store.getConversation(user.id, asked.conversationId)!.messages;
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(stored[0].createdAt).toBe("2026-10-09T15:59:59.000Z");
    expect(stored[1].createdAt).toBe("2026-10-09T16:00:01.000Z");
  });

  it("keeps today relative to when the request arrived when the provider call spans midnight", async () => {
    vi.setSystemTime(new Date("2026-10-09T15:59:59.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => {
      vi.setSystemTime(new Date("2026-10-09T16:00:01.000Z"));
      return providerTool("log_transaction", { amount: "250", category: "Food", description: "lunch" });
    }));
    const saved = await (await POST(assistantRequest("lunch 250 today"))).json();

    expect(saved.transaction.date).toBe("2026-10-09");
    expect(store.getConversation(user.id, saved.conversationId)!.messages[0].createdAt).toBe("2026-10-09T15:59:59.000Z");
  });

  it("keeps today relative to when the request arrived when the clock moves backwards", async () => {
    vi.setSystemTime(new Date("2026-10-09T16:00:01.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "How can I help?" })));
    const started = await (await POST(assistantRequest("hello"))).json();

    vi.setSystemTime(new Date("2026-10-09T15:59:59.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "How much was lunch?" })));
    await POST(assistantRequest("lunch today", started.conversationId));

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "250", category: "Food", description: "lunch" })));
    const result = await (await POST(assistantRequest("250", started.conversationId))).json();

    expect(result.transaction.date).toBe("2026-10-09");
    const stored = store.getConversation(user.id, started.conversationId)!.messages;
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(stored[2].createdAt).toBe("2026-10-09T15:59:59.000Z");
  });

  it("keeps the pending repayment question and its earlier context when the model call fails", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const asked = await (await POST(assistantRequest("Ana paid me"))).json();
    expect(store.getConversation(user.id, asked.conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    expect((await POST(assistantRequest("500", asked.conversationId))).status).toBe(400);
    expect(store.getConversation(user.id, asked.conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");

    const retry = vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" }));
    vi.stubGlobal("fetch", retry);
    const response = await POST(assistantRequest("500", asked.conversationId));

    const sent = JSON.parse(String((retry.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as ProviderRequest;
    expect(sent.messages.map((message) => message.content)).toContain("Ana paid me");
    expect(response.status).toBe(200);
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000, status: "open" });
  });

  // main's strict reading of an answer to "How much?": digits with an optional peso sign or word, nothing else.
  for (const reply of ["500", "₱500", "500 php", "500 pesos", "500."]) {
    it(`records the repayment when "${reply}" answers the pending amount question`, async () => {
      const { debt, conversationId } = await askAnaPaidMe();

      vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })));
      const result = await (await POST(assistantRequest(reply, conversationId))).json();

      expect(result.answer).toContain("repayment from Ana");
      expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000, status: "open" });
      expect(store.listTransactions(user.id)).toHaveLength(1);
      expect(store.listTransactions(user.id)[0]).toMatchObject({ amountMinor: 50_000, kind: "debt_repayment", categoryName: null });
    });
  }

  for (const reply of ["maybe 500", "perhaps 500", "I think 500", "probably 500", "not 500"]) {
    it(`asks first and writes nothing when "${reply}" hedges the pending repayment amount`, async () => {
      const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
      vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
      const asked = await (await POST(assistantRequest("Ana paid me"))).json();

      const second = vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "expense", description: "Payment", category: "Other" }));
      vi.stubGlobal("fetch", second);
      const result = await (await POST(assistantRequest(reply, asked.conversationId))).json();

      const sent = JSON.parse(String((second.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as ProviderRequest;
      expect(sent.messages.map((message) => message.content)).toContain("Ana paid me");
      expect(result.answer).toContain("I didn't record anything");
      expect(result.transaction).toBeNull();
      expect(store.listTransactions(user.id)).toHaveLength(0);
      expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
    });
  }

  const notBareAmounts = ["P500", "PHP 500", "500 pesos po", "it was 500", "about 500", "around 500", "roughly 500", "approximately 500", "500 cash", "500 in cash", "500 to Wallet", "500 sa GCash", "500 to Savings", "500 from Savings to GCash", "500 yesterday", "500 last night", "500 kahapon", "500 kanina",
    "5k", "5 hundred", "500 daw", "500 bucks", "500 lng", "mga 500", "She paid 500", "paid 500", "received 500", "binayaran nya 500",
    "500-ish", "500 ata", "500 cguro", "parang 500", "di 500"];
  const providerGuesses: [string, () => Response][] = [
    ["a repayment of 500", () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })],
    ["an expense of 500", () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "expense", category: "Other" })],
  ];
  for (const reply of notBareAmounts) {
    for (const [guess, response] of providerGuesses) {
      it(`asks for the amount again and writes nothing when "${reply}" is not a bare amount and the model guesses ${guess}`, async () => {
        store.createAccount(user.id, { name: "GCash", type: "cash", openingMinor: 0 });
        store.createAccount(user.id, { name: "Savings", type: "bank", openingMinor: 0 });
        const { debt, conversationId } = await askAnaPaidMe();

        const second = vi.fn(async () => response());
        vi.stubGlobal("fetch", second);
        const result = await (await POST(assistantRequest(reply, conversationId))).json();

        const sent = JSON.parse(String((second.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as ProviderRequest;
        expect(sent.messages.map((message) => message.content)).toContain("Ana paid me");
        expect(result.answer).toBe(amountReask);
        expect(result.transaction).toBeNull();
        expect(store.listTransactions(user.id)).toHaveLength(0);
        expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
        expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");
      });
    }
  }

  it.each(["She paid 500", "500 to Savings", "5 hundred", "500 ata"])("keeps the pending ordinary income question and writes nothing when %s replies", async (reply) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Zed", amount: "500" })));
    const asked = await (await POST(assistantRequest("Zed paid me 500"))).json();
    expect(asked.answer).toContain("ordinary income");

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "income", category: "Other income" })));
    const result = await (await POST(assistantRequest(reply, asked.conversationId))).json();

    expect(result.answer).toBe(incomeReask);
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, asked.conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");
  });

  it.each(["She paid 500", "500 to Wallet", "5 hundred"])("keeps the pending payer question and writes nothing when %s replies", async (reply) => {
    const momDebt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Dad", amountMinor: 30_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" })));
    const asked = await (await POST(assistantRequest("I paid Mom and Dad 100"))).json();
    expect(asked.answer).toContain("Which person's open debt");

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "expense", category: "Other" })));
    const result = await (await POST(assistantRequest(reply, asked.conversationId))).json();

    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.listDebts(user.id).find((item) => item.id === momDebt.id)).toMatchObject({ amountMinor: 20_000, status: "open" });
  });

  // Round 4: replies with a category word that are real answers or payment statements, hedges with a category,
  // and an account whose name holds a category word. None may write, and each re-asks with the way out.
  const categoryReplies = [
    "she paid back the food money, 500", "for the food, 500", "bayad sa food 500", "binayaran nya yung food 500", "She paid for the Transport 200", "She paid 500 for lunch",
    "I guess Food 500", "Food about 500", "siguro Food 500", "hindi Food 500", "to Food Wallet 500", "500 to Food Wallet",
    "Coffee 120", "lunch 250", "Grab 180", "bought coffee 120",
  ];
  const expenseGuess = () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "expense", category: "Food", account: "Food Wallet" });
  const repaymentGuess = () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" });
  for (const reply of categoryReplies) {
    for (const [guess, response] of [["an expense", expenseGuess], ["a repayment", repaymentGuess]] as const) {
      it(`keeps the repayment amount question, writes nothing and offers cancel for "${reply}" when the model guesses ${guess}`, async () => {
        store.createAccount(user.id, { name: "Food Wallet", type: "cash", openingMinor: 0 });
        const { debt, conversationId } = await askAnaPaidMe();

        const second = vi.fn(async () => response());
        vi.stubGlobal("fetch", second);
        const result = await (await POST(assistantRequest(reply, conversationId))).json();

        expect(sentTo(second.mock.calls[0])).toContain("Ana paid me");
        expect(result.answer).toBe(amountReask);
        expect(result.transaction).toBeNull();
        expect(result.undoUntil).toBeNull();
        expect(store.listTransactions(user.id)).toHaveLength(0);
        expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
        expect(store.listAccounts(user.id).every((account) => account.balanceMinor === 0)).toBe(true);
        expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");
      });
    }
  }

  it.each([
    "siguro Other income 500", "siguro Food 500", "I guess Food 500", "Food about 500", "to Food Wallet 500", "Coffee 120", "lunch 250",
  ])("keeps the ordinary income question, writes nothing and offers cancel for %s", async (reply) => {
    store.createAccount(user.id, { name: "Food Wallet", type: "cash", openingMinor: 0 });
    const conversationId = await askZedPaidMe();

    const second = vi.fn(async () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "income", category: "Other income" }));
    vi.stubGlobal("fetch", second);
    const result = await (await POST(assistantRequest(reply, conversationId))).json();

    expect(sentTo(second.mock.calls[0])).toContain("Zed paid me 500");
    expect(result.answer).toBe(incomeReask);
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");
  });

  it("asks the ordinary income question again for a finance question instead of answering it, and answers a debt list locally, leaving the question pending either way", async () => {
    const conversationId = await askZedPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

    const asked = await (await POST(assistantRequest("How much did I spend this month?", conversationId))).json();

    expect(asked.answer).toBe(incomeReask);
    expect(asked.transaction).toBeNull();
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");

    const local = vi.fn();
    vi.stubGlobal("fetch", local);
    const listed = await (await POST(assistantRequest("List my debts", conversationId))).json();

    expect(local).not.toHaveBeenCalled();
    expect(listed.answer).not.toBe(incomeReask);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");
    expect(store.listTransactions(user.id)).toHaveLength(0);
  });

  it.each(["maybe", "I think so", "not sure", "maybe 500"])("asks the ordinary income question again, with the way out, when the hedged reply %s answers it", async (reply) => {
    const conversationId = await askZedPaidMe();

    const second = vi.fn(async () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "income", category: "Other income" }));
    vi.stubGlobal("fetch", second);
    const result = await (await POST(assistantRequest(reply, conversationId))).json();

    expect(result.answer).toBe(incomeReask);
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");
  });

  it.each(["He paid back the food money, 500", "she paid back the food money, 500", "She paid 500 for lunch"])(
    "writes nothing and offers cancel when %s answers the ordinary income question", async (reply) => {
      const conversationId = await askZedPaidMe();

      vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "500", description: "Food", kind: "expense", category: "Food" })));
      const result = await (await POST(assistantRequest(reply, conversationId))).json();

      expect(result.answer).toMatch(/say cancel to drop this\.$/);
      expect(result.transaction).toBeNull();
      expect(store.listTransactions(user.id)).toHaveLength(0);
    });

  it("keeps the repayment payer question, writes nothing and offers cancel when more than one payer is named", async () => {
    const momDebt = store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Dad", amountMinor: 30_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" })));
    const asked = await (await POST(assistantRequest("I paid Mom and Dad 100"))).json();
    expect(asked.answer).toBe("Which person's open debt should I apply this payment to?");

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" })));
    const result = await (await POST(assistantRequest("Mom and Dad", asked.conversationId))).json();

    expect(result.answer).toBe("Which person's open debt should I apply this payment to? Reply with the person's name, or say cancel to drop this.");
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.listDebts(user.id).find((item) => item.id === momDebt.id)).toMatchObject({ amountMinor: 20_000, status: "open" });
    expect(store.getConversation(user.id, asked.conversationId)!.messages.at(-1)!.followup).toBe("repayment_payer");
  });

  it("answers Coffee 120 by asking again, then drops the question on cancel and saves Coffee 120 in a clean context", async () => {
    const { debt, conversationId } = await askAnaPaidMe();

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food" })));
    const reasked = await (await POST(assistantRequest("Coffee 120", conversationId))).json();
    expect(reasked.answer).toBe(amountReask);
    expect(store.listTransactions(user.id)).toHaveLength(0);

    const provider = vi.fn(async () => providerTool("log_transaction", { amount: "999", kind: "expense", category: "Other" }));
    vi.stubGlobal("fetch", provider);
    const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();
    expect(provider).not.toHaveBeenCalled();
    expect(cancelled).toMatchObject({ conversationId, transaction: null, debt: null, undoUntil: null });
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
    const stored = store.getConversation(user.id, conversationId)!.messages;
    expect(stored.at(-1)).toMatchObject({ role: "assistant", followup: null });
    expect(stored.at(-2)).toMatchObject({ role: "user", content: "cancel" });

    const third = vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food" }));
    vi.stubGlobal("fetch", third);
    const saved = await (await POST(assistantRequest("Coffee 120", conversationId))).json();

    expect(sentTo(third.mock.calls[0])).not.toContain("Ana paid me");
    expect(saved.transaction).toMatchObject({ kind: "expense", amountMinor: 12_000, categoryName: "Food" });
    expect(saved.answer).not.toContain("repayment");
    expect(store.listTransactions(user.id)).toHaveLength(1);
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
  });

  it("never reloads a cancelled question into a later turn of the same chat", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food", account: "Missing" })));
    await POST(assistantRequest("never mind", conversationId));

    const next = vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food", account: "Missing" }));
    vi.stubGlobal("fetch", next);
    const asked = await (await POST(assistantRequest("Coffee 120 from Missing", conversationId))).json();
    expect(asked.answer).toContain("Missing");

    const last = vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food", account: "Wallet" }));
    vi.stubGlobal("fetch", last);
    const saved = await (await POST(assistantRequest("Wallet", conversationId))).json();

    expect(sentTo(last.mock.calls[0])).not.toContain("Ana paid me");
    expect(saved.transaction).toMatchObject({ kind: "expense", amountMinor: 12_000 });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
  });

  it.each(["cancel", "Never mind.", "skip", "forget it", "stop", "ayoko na", "wag na", "huwag na", "di na"])("drops a pending ordinary income question on %s", async (reply) => {
    const conversationId = await askZedPaidMe();
    const provider = vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "income", category: "Other income" }));
    vi.stubGlobal("fetch", provider);

    const result = await (await POST(assistantRequest(reply, conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(result.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("drops a pending repayment payer question on cancel", async () => {
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Mom", amountMinor: 20_000 });
    store.createDebt(user.id, { direction: "you_owe", counterparty: "Dad", amountMinor: 30_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" })));
    const asked = await (await POST(assistantRequest("I paid Mom and Dad 100"))).json();
    const provider = vi.fn(async () => providerTool("record_debt_repayment", { counterparty: "Mom", amount: "100" }));
    vi.stubGlobal("fetch", provider);

    const result = await (await POST(assistantRequest("cancel", asked.conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(result.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, asked.conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("offers cancel when an account question is asked again, and drops it on cancel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food", account: "Missing" })));
    const asked = await (await POST(assistantRequest("Coffee 120 from Missing"))).json();
    expect(asked.answer).toContain("Missing");
    expect(asked.answer).not.toContain("cancel");

    const again = await (await POST(assistantRequest("lunch 250", asked.conversationId))).json();
    expect(again.answer).toContain("Missing");
    expect(again.answer).toMatch(/Or say cancel to drop this\.$/);
    expect(store.listTransactions(user.id)).toHaveLength(0);

    const provider = vi.fn(async () => providerTool("log_transaction", { amount: "1", kind: "expense", category: "Food" }));
    vi.stubGlobal("fetch", provider);
    const cancelled = await (await POST(assistantRequest("cancel", asked.conversationId))).json();
    expect(provider).not.toHaveBeenCalled();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.listTransactions(user.id)).toHaveLength(0);
  });

  it("does not offer cancel on the first ask of a repayment question", async () => {
    store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const asked = await (await POST(assistantRequest("Ana paid me"))).json();
    expect(asked.answer).toBe("What amount should I use for the repayment?");
  });

  it("keeps the model's own question as it was worded during a repayment, and the repayment question stays pending", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "Which account did Ana send it to?" })));

    const asked = await (await POST(assistantRequest("she sent it through gcash", conversationId))).json();

    expect(asked.answer).toBe("Which account did Ana send it to?");
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("repayment_amount");
    expect(store.listTransactions(user.id)).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })));
    const answered = await (await POST(assistantRequest("500", conversationId))).json();
    expect(answered.transaction).toMatchObject({ kind: "debt_repayment", amountMinor: 50_000 });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000, status: "open" });
  });

  it("still ends a question the code asks again with the way out, even when the model's own call was set aside", async () => {
    await askAnaPaidMe();
    const conversationId = store.listConversations(user.id)[0].id;
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "Which account did Ana send it to?" })));
    await POST(assistantRequest("she sent it through gcash", conversationId));

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const reasked = await (await POST(assistantRequest("Ana paid me again", conversationId))).json();

    expect(reasked.answer).toBe(amountReask);
  });

  it("offers cancel when a bill question is asked again, and drops it on cancel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", {
      name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-20", endDate: "2026-10-20",
    })));
    const first = await (await POST(assistantRequest("I have a monthly Internet bill for ₱500."))).json();
    expect(first.answer).not.toContain("cancel");

    const again = await (await POST(assistantRequest("Coffee 120", first.conversationId))).json();
    expect(again.answer).toMatch(/Or say cancel to drop this\.$/);
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.listTransactions(user.id)).toHaveLength(0);

    const provider = vi.fn(async () => providerTool("create_bill", { name: "Internet", amount: "500", frequency: "monthly", nextDueDate: "2026-10-20" }));
    vi.stubGlobal("fetch", provider);
    const cancelled = await (await POST(assistantRequest("cancel", first.conversationId))).json();
    expect(provider).not.toHaveBeenCalled();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(store.listBills(user.id)).toEqual([]);
    expect(store.getConversation(user.id, first.conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("tells the user the debt stays in Debts when they cancel the offer to add it to Transactions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Ana", amount: "500" })));
    const first = await (await POST(assistantRequest("Ana owes me 500"))).json();
    expect(first.answer).toContain("Added it to Debts only");
    expect(store.getConversation(user.id, first.conversationId)!.messages.at(-1)!.followup).toBe("debt_transaction");
    const provider = vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Ana", amount: "500" }));
    vi.stubGlobal("fetch", provider);

    const cancelled = await (await POST(assistantRequest("skip", first.conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(cancelled.answer).toBe("Okay, I dropped that question. The debt stays in Debts, and nothing was added to Transactions.");
    expect(store.listDebts(user.id)).toMatchObject([{ counterparty: "Ana", amountMinor: 50_000, status: "open" }]);
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, first.conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("still says the debt stays when the cancel comes after the request to add it to Transactions asked for an account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Ana", amount: "500" })));
    const first = await (await POST(assistantRequest("Ana owes me 500"))).json();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Ana", amount: "500", recordTransaction: true, note: "lunch", account: "Missing" })));
    const asked = await (await POST(assistantRequest("Add it to Transactions, it was lunch", first.conversationId))).json();
    expect(asked.answer).toContain("Missing");
    expect(store.getConversation(user.id, first.conversationId)!.messages.at(-1)!.followup).toBe("account_or_date");

    const cancelled = await (await POST(assistantRequest("cancel", first.conversationId))).json();

    expect(cancelled.answer).toBe("Okay, I dropped that question. The debt stays in Debts, and nothing was added to Transactions.");
    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(store.listTransactions(user.id)).toHaveLength(0);
  });

  it("treats no as a decline of the ordinary income question, not as a cancel", async () => {
    const conversationId = await askZedPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "income", category: "Other income" })));

    const result = await (await POST(assistantRequest("no", conversationId))).json();

    expect(result.answer).toBe("Okay, I won't record the money.");
    expect(store.listTransactions(user.id)).toHaveLength(0);
  });

  it.each(["No", "nope.", "Nah", "No thanks!", "no thank you", "hindi", "Ayoko"])("declines the ordinary income question on the exact phrase %s", async (reply) => {
    const conversationId = await askZedPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "income", category: "Other income" })));

    const result = await (await POST(assistantRequest(reply, conversationId))).json();

    expect(result.answer).toBe("Okay, I won't record the money.");
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  // ecad4c6 let an earlier yes authorize the write after any reply that was not an exact decline, so a refusal that
  // began with no and said more saved the income against the user's words. The earlier yes now stands only when the
  // current message does not lead with a negative word. "No, use Wallet. I still want to record it as income." asks
  // once more, which is the accepted cost of the safe direction.
  it("records the income a user confirmed when a reply after an account clarification says yes", async () => {
    const conversationId = await askZedPaidMe();
    const held = await (await POST(assistantRequest("yes, into my Nowhere account", conversationId))).json();
    expect(held.transaction).toBeNull();
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("account_or_date");
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", category: "Other income", account: "Wallet" })));

    const result = await (await POST(assistantRequest("yes, use Wallet", conversationId))).json();

    expect(result.answer).not.toMatch(/won't record the money/i);
    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 50_000, accountName: "Wallet" });
    expect(store.listAccounts(user.id).find((account) => account.name === "Wallet")!.balanceMinor).toBe(50_000);
  });

  it.each([
    "No, don't record this in Wallet or anywhere else.",
    "No, don't record it",
    "no, I changed my mind",
    "No, never mind",
    "No, use Wallet. I still want to record it as income.",
  ])("does not write on the strength of an earlier yes when the reply %s leads with no: it asks again and writes nothing", async (reply) => {
    const conversationId = await askZedPaidMe();
    const held = await (await POST(assistantRequest("yes, into my Nowhere account", conversationId))).json();
    expect(held.transaction).toBeNull();
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("account_or_date");
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", category: "Other income", account: "Wallet" })));

    const result = await (await POST(assistantRequest(reply, conversationId))).json();

    expect(result.answer).toBe(incomeReask);
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.listAccounts(user.id).find((account) => account.name === "Wallet")!.balanceMinor).toBe(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");
  });

  it("asks for a fresh yes after a vetoed one: the question is pending again, and cancel still drops it", async () => {
    const conversationId = await askZedPaidMe();
    await POST(assistantRequest("yes, into my Nowhere account", conversationId));
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", category: "Other income", account: "Wallet" })));
    await POST(assistantRequest("No, don't record it", conversationId));

    const unclear = await (await POST(assistantRequest("Wallet", conversationId))).json();
    expect(unclear.transaction).toBeNull();
    expect(unclear.answer).toBe(incomeReask);

    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();
    expect(provider).not.toHaveBeenCalled();
    expect(cancelled.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBeNull();
  });

  it("records the income after a vetoed yes once the user says yes again", async () => {
    const conversationId = await askZedPaidMe();
    await POST(assistantRequest("yes, into my Nowhere account", conversationId));
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", category: "Other income", account: "Wallet" })));
    await POST(assistantRequest("No, don't record it", conversationId));

    const result = await (await POST(assistantRequest("yes, record it in Wallet", conversationId))).json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 50_000, accountName: "Wallet" });
  });

  it.each(["No, use Wallet", "no problem, yes record it", "not now", "Nope, but record it in Wallet", "no way"])("does not read %s as a decline: it asks again with the cancel hint and writes nothing", async (reply) => {
    const conversationId = await askZedPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "income", category: "Other income", account: "Wallet" })));

    const result = await (await POST(assistantRequest(reply, conversationId))).json();

    expect(result.answer).toBe(incomeReask);
    expect(result.transaction).toBeNull();
    expect(store.listTransactions(user.id)).toHaveLength(0);
    expect(store.getConversation(user.id, conversationId)!.messages.at(-1)!.followup).toBe("ordinary_income");
  });

  it("treats cancel with no pending question as an ordinary prompt", async () => {
    const provider = vi.fn(async () => providerTool("ask_clarification", { question: "What would you like me to cancel?" }));
    vi.stubGlobal("fetch", provider);

    const first = await (await POST(assistantRequest("cancel"))).json();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(first.answer).toBe("What would you like me to cancel?");
    expect(store.getConversation(user.id, first.conversationId)!.messages.map((message) => message.content)).toEqual(["cancel", "What would you like me to cancel?"]);

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food" })));
    const saved = await (await POST(assistantRequest("Coffee 120", first.conversationId))).json();
    const afterSave = vi.fn(async () => providerTool("ask_clarification", { question: "Nothing is pending to cancel." }));
    vi.stubGlobal("fetch", afterSave);
    const second = await (await POST(assistantRequest("cancel", saved.conversationId))).json();

    expect(afterSave).toHaveBeenCalledTimes(1);
    expect(second.answer).toBe("Nothing is pending to cancel.");
    expect(store.listTransactions(user.id)).toHaveLength(1);
  });

  it("answers a pending repayment amount with a bare amount and records the repayment", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const asked = await (await POST(assistantRequest("Ana paid me"))).json();

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })));
    const result = await (await POST(assistantRequest("500", asked.conversationId))).json();

    expect(result.transaction).toMatchObject({ amountMinor: 50_000 });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000, status: "open" });
  });

  // A turn that only reads, the debt list or a finance answer, answers its own request and leaves a pending question where it was.
  const expenseGuess500 = () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "expense", category: "Other" });
  const lastStored = (conversationId: string) => store.getConversation(user.id, conversationId)!.messages.at(-1)!;
  async function expectAnaRepaid500(conversationId: string, debtId: string) {
    const provider = vi.fn(async () => expenseGuess500());
    vi.stubGlobal("fetch", provider);
    const result = await (await POST(assistantRequest("500", conversationId))).json();

    expect(sentTo(provider.mock.calls[0])).toContain("Ana paid me");
    expect(result.answer).toContain("repayment from Ana");
    expect(result.transaction).toMatchObject({ amountMinor: 50_000, kind: "debt_repayment", categoryName: null, debtId });
    expect(store.listTransactions(user.id).filter((item) => item.debtId === debtId)).toHaveLength(1);
    expect(store.listTransactions(user.id).filter((item) => item.kind === "expense" && item.description === "Payment")).toEqual([]);
    expect(store.listDebts(user.id).find((item) => item.id === debtId)).toMatchObject({ amountMinor: 50_000, status: "open" });
    expect(lastStored(conversationId).followup).toBeNull();
  }

  it.each(["List my debts", "Who owes me?"])("keeps the pending repayment question when %s is answered locally, so 500 still repays Ana", async (prompt) => {
    const { debt, conversationId } = await askAnaPaidMe();
    const local = vi.fn();
    vi.stubGlobal("fetch", local);

    const listed = await (await POST(assistantRequest(prompt, conversationId))).json();

    expect(local).not.toHaveBeenCalled();
    expect(listed.answer).toContain("Ana: ₱1,000.00");
    expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });
    await expectAnaRepaid500(conversationId, debt.id);
  });

  it.each(["How much did I spend this month?", "Show my spending this month"])(
    "keeps the pending repayment question when the finance question %s is answered, so 500 still repays Ana", async (prompt) => {
      seedDebtFinanceFacts();
      const { debt, conversationId } = await askAnaPaidMe();
      vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

      const answered = await (await POST(assistantRequest(prompt, conversationId))).json();

      expect(answered.answer).toContain("Total Spent");
      expect(answered.answer).not.toContain("I didn't record anything");
      expect(answered).toMatchObject({ transaction: null, undoUntil: null });
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });
      await expectAnaRepaid500(conversationId, debt.id);
    });

  it("answers a repayments report and keeps the pending repayment question, without the uncertain-payment reply", async () => {
    seedDebtFinanceFacts();
    const { conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));

    const answered = await (await POST(assistantRequest("How much have people paid me back this month?", conversationId))).json();

    expect(answered.answer).toContain("Repayments received");
    expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });
  });

  it("keeps the pending ordinary income question through a local debt list, so yes still records the income", async () => {
    const conversationId = await askZedPaidMe();
    vi.stubGlobal("fetch", vi.fn());
    await POST(assistantRequest("List my debts", conversationId));
    expect(lastStored(conversationId).followup).toBe("ordinary_income");

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Zed", amount: "500" })));
    const result = await (await POST(assistantRequest("yes", conversationId))).json();

    expect(result.transaction).toMatchObject({ kind: "income", amountMinor: 50_000, categoryName: "Other income" });
  });

  it("keeps a model-worded clarification through a finance answer, so the answer still completes the transaction", async () => {
    seedDebtFinanceFacts();
    store.createAccount(user.id, { name: "Spare", type: "cash", openingMinor: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "How much was the coffee?" })));
    const asked = await (await POST(assistantRequest("I bought coffee"))).json();
    expect(lastStored(asked.conversationId).followup).toBe("clarification");

    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));
    await POST(assistantRequest("Show my spending this month", asked.conversationId));
    expect(lastStored(asked.conversationId).followup).toBe("clarification");

    const provider = vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food" }));
    vi.stubGlobal("fetch", provider);
    const saved = await (await POST(assistantRequest("120", asked.conversationId))).json();

    expect(sentTo(provider.mock.calls[0])).toContain("I bought coffee");
    expect(saved.transaction).toMatchObject({ kind: "expense", amountMinor: 12_000, categoryName: "Food" });
  });

  it("keeps the offer to add a saved debt to Transactions, and its debt, through a local debt list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Mom", amount: "27", note: "Jollibee", recordTransaction: true })));
    const first = await (await POST(assistantRequest("Mom owes me 27"))).json();
    expect(lastStored(first.conversationId).followup).toBe("debt_transaction");

    await POST(assistantRequest("List my debts", first.conversationId));
    expect(lastStored(first.conversationId)).toMatchObject({ followup: "debt_transaction", debtId: first.debt.id });

    const result = await (await POST(assistantRequest("Add it to Transactions; it was Jollibee", first.conversationId))).json();

    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(result.transaction).toMatchObject({ kind: "expense", amountMinor: 2_700 });
    expect(result.debt).toMatchObject({ id: first.debt.id });
  });

  it("still drops the question on cancel after a read-only answer, and the next prompt starts clean", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn());
    await POST(assistantRequest("List my debts", conversationId));

    const provider = vi.fn(async () => expenseGuess500());
    vi.stubGlobal("fetch", provider);
    const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(lastStored(conversationId).followup).toBeNull();

    const next = vi.fn(async () => providerTool("log_transaction", { amount: "500", description: "Payment", kind: "expense", category: "Other" }));
    vi.stubGlobal("fetch", next);
    const saved = await (await POST(assistantRequest("500", conversationId))).json();

    expect(sentTo(next.mock.calls[0])).not.toContain("Ana paid me");
    expect(saved.transaction).toMatchObject({ kind: "expense", amountMinor: 50_000 });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
  });

  it("stores no pending question for a read-only turn when none was pending, and after a repayment that completed", async () => {
    seedDebtFinanceFacts();
    vi.stubGlobal("fetch", vi.fn());
    const listed = await (await POST(assistantRequest("List my debts"))).json();
    expect(lastStored(listed.conversationId).followup).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => financeQuestionResponse()));
    await POST(assistantRequest("How much did I spend this month?", listed.conversationId));
    expect(lastStored(listed.conversationId)).toMatchObject({ followup: null });

    const { conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500" })));
    await POST(assistantRequest("500", conversationId));
    expect(lastStored(conversationId).followup).toBeNull();
    vi.stubGlobal("fetch", vi.fn());
    await POST(assistantRequest("List my debts", conversationId));
    expect(lastStored(conversationId).followup).toBeNull();
  });

  const billSpec = () => providerTool("create_bill", { name: "Netflix", amount: "549", frequency: "monthly", nextDueDate: "2026-10-09", endDate: "2026-12-15", category: "Entertainment" });
  const billPrompt = "I have a Netflix bill under Entertainment. It is ₱549 monthly, started today, and ends December 15.";

  it("keeps the pending repayment question when a bill is saved without asking anything", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => billSpec()));

    const saved = await (await POST(assistantRequest(billPrompt, conversationId))).json();

    expect(saved.bill).toMatchObject({ name: "Netflix", amountMinor: 54_900 });
    expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });
    await expectAnaRepaid500(conversationId, debt.id);
  });

  describe("a bill saved under a pending repayment question", () => {
    const billStays = "The bill stays in Bills, and nothing else was recorded.";
    async function saveBillUnderAnaQuestion() {
      const { debt, conversationId } = await askAnaPaidMe();
      vi.stubGlobal("fetch", vi.fn(async () => billSpec()));
      const saved = await (await POST(assistantRequest(billPrompt, conversationId))).json();
      expect(saved.bill).toMatchObject({ name: "Netflix" });
      expect(lastStored(conversationId).followup).toBe("repayment_amount");
      expect(store.listBills(user.id)).toHaveLength(1);
      expect(store.listTransactions(user.id)).toHaveLength(1);
      return { debt, conversationId };
    }
    function expectBillKept(debtId: string) {
      expect(store.listBills(user.id)).toHaveLength(1);
      expect(store.listTransactions(user.id)).toHaveLength(1);
      expect(store.listDebts(user.id).find((item) => item.id === debtId)).toMatchObject({ amountMinor: 100_000, status: "open" });
    }

    it("says the bill stays in Bills when the question is cancelled, not that nothing was recorded", async () => {
      const { debt, conversationId } = await saveBillUnderAnaQuestion();
      vi.stubGlobal("fetch", vi.fn());

      const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();

      expect(cancelled.answer).toBe(`Okay, I dropped that question. ${billStays}`);
      expect(lastStored(conversationId).followup).toBeNull();
      expectBillKept(debt.id);
    });

    it("says the bill stays in Bills when the question expires, not that nothing was recorded", async () => {
      const { debt, conversationId } = await saveBillUnderAnaQuestion();
      vi.stubGlobal("fetch", vi.fn());
      for (let round = 0; round < 10; round++) await POST(assistantRequest("List my debts", conversationId));
      expect(store.getConversation(user.id, conversationId)!.messages).toHaveLength(24);

      const expired = await (await POST(assistantRequest("List my debts", conversationId))).json();

      expect(expired.answer).toBe(`That question has been open too long, so I dropped it. ${billStays}`);
      expect(lastStored(conversationId).followup).toBeNull();
      expectBillKept(debt.id);
    });

    it("names both when the run also saved a debt", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Cara", amount: "300" })));
      const first = await (await POST(assistantRequest("Cara owes me 300"))).json();
      expect(lastStored(first.conversationId).followup).toBe("debt_transaction");
      vi.stubGlobal("fetch", vi.fn(async () => billSpec()));
      const saved = await (await POST(assistantRequest(billPrompt, first.conversationId))).json();
      expect(saved.bill).toMatchObject({ name: "Netflix" });
      vi.stubGlobal("fetch", vi.fn());

      const cancelled = await (await POST(assistantRequest("cancel", first.conversationId))).json();

      expect(cancelled.answer).toBe("Okay, I dropped that question. The debt stays in Debts and the bill stays in Bills.");
    });
  });

  // A turn that handled something else and left the question pending says nothing about that question, so the
  // account and the date it mentions must not reach the repayment. The model still sees the whole run.
  describe("quiet turns inside a pending repayment run", () => {
    const savingsBillPrompt = "I have a Netflix bill under Entertainment using Savings. It is ₱549 monthly, starts tomorrow, and ends December 15.";
    const repaymentCall = (args: Record<string, unknown>) => vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", ...args }));
    async function send(prompt: string, conversationId: string, provider: ReturnType<typeof vi.fn>) {
      vi.stubGlobal("fetch", provider);
      return (await POST(assistantRequest(prompt, conversationId))).json();
    }
    beforeEach(() => { store.createAccount(user.id, { name: "Savings", type: "bank", openingMinor: 0 }); });

    it("credits the model's account and date, not the ones in a bill saved under the question", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      const bill = await send(savingsBillPrompt, conversationId, vi.fn(async () => providerTool("create_bill", {
        name: "Netflix", amount: "549", frequency: "monthly", nextDueDate: "2026-10-10", endDate: "2026-12-15", category: "Entertainment", account: "Savings",
      })));
      expect(bill.bill).toMatchObject({ name: "Netflix", accountName: "Savings", nextDueDate: "2026-10-10" });
      const provider = repaymentCall({ amount: "500", account: "Wallet", date: "2026-10-09" });

      const result = await send("Ana paid me 500", conversationId, provider);

      expect(sentTo(provider.mock.calls[0])).toContain(savingsBillPrompt);
      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, amountMinor: 50_000, accountName: "Wallet", date: "2026-10-09" });
    });

    it("credits the model's date and account, not the ones in a finance question answered under the question", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      await send("How much did I spend on 2026-09-30 using Savings?", conversationId, vi.fn(async () => providerTool("finance_question", { start: "2026-09-30", end: "2026-09-30" })));
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });
      const provider = repaymentCall({ amount: "500", account: "Wallet", date: "2026-10-09" });

      const result = await send("Ana paid me 500", conversationId, provider);

      expect(sentTo(provider.mock.calls[0])).toContain("How much did I spend on 2026-09-30 using Savings?");
      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, accountName: "Wallet", date: "2026-10-09" });
    });

    it("credits the model's account and date after a debt list answered under the question", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      await send("Who owes me? Answer for 2026-09-30 in Savings account", conversationId, vi.fn());
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });

      const result = await send("500", conversationId, repaymentCall({ amount: "500", account: "Wallet", date: "2026-10-09" }));

      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, accountName: "Wallet", date: "2026-10-09" });
    });

    it("still credits the account a user names in an answer to the question", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      const reasked = await send("Actually into Savings", conversationId, repaymentCall({}));
      expect(reasked.transaction).toBeNull();
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });

      const result = await send("500", conversationId, repaymentCall({ amount: "500", account: "Wallet" }));

      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, accountName: "Savings" });
    });

    it("still takes a date corrected after a quiet turn", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      await send("How much did I spend on 2026-09-30?", conversationId, vi.fn(async () => providerTool("finance_question", { start: "2026-09-30", end: "2026-09-30" })));
      await send("Actually yesterday", conversationId, repaymentCall({}));
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount" });

      const result = await send("500", conversationId, repaymentCall({ amount: "500", date: "2026-10-09" }));

      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, date: "2026-10-08" });
    });

    it("still takes the account named in the statement that started the question", async () => {
      const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
      const first = await send("Ana paid me into my Savings account", "", repaymentCall({}));
      const conversationId = first.conversationId as string;
      await send(savingsBillPrompt.replace("Savings", "Wallet"), conversationId, vi.fn(async () => billSpec()));

      const result = await send("500", conversationId, repaymentCall({ amount: "500", account: "Wallet" }));

      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, accountName: "Savings" });
    });

    // Refusal wording is a guard, not a hint: it blocks an unconfirmed write wherever in the run it was said.
    it("records nothing after a negation said in a local debt list turn, even though that turn is quiet", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      const provider = vi.fn(async () => providerTool("record_debt_payment", {}));
      const listed = await send("Actually, Ana did not pay me. List my debts.", conversationId, provider);
      expect(provider).not.toHaveBeenCalled();
      expect(listed.transaction).toBeNull();
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount", readOnly: true });

      const result = await send("500", conversationId, repaymentCall({ amount: "500" }));

      expect(result.transaction).toBeNull();
      expect(store.listTransactions(user.id)).toHaveLength(0);
      expect(store.listDebts(user.id).find((item) => item.id === debt.id)?.amountMinor).toBe(100_000);
    });

    // A bill turn that carries refusal wording is guarded at its own turn, which ends the question, so no negation
    // is ever left in a bill-saved quiet turn for the next reply to read. The guard decides before the turn is stored.
    it("ends the repayment question when a bill is saved in a message that negates the payment", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      const bill = await send(`Ana has not paid me. ${billPrompt}`, conversationId, vi.fn(async () => billSpec()));
      expect(bill.bill).toMatchObject({ name: "Netflix" });
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: null, billId: bill.bill.id });
      expect(store.listTransactions(user.id).filter((item) => item.kind === "debt_repayment")).toHaveLength(0);
      expect(store.listDebts(user.id).find((item) => item.id === debt.id)?.amountMinor).toBe(100_000);
    });

    // A yes is a hint toward a write, so it must be said to the question, not inside a turn that answered something else.
    it("does not take a yes said in a debt list turn as the answer to the ordinary income question", async () => {
      const conversationId = await askZedPaidMe();
      await send("Yes, list my debts", conversationId, vi.fn());
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "ordinary_income", readOnly: true });

      const result = await send("500", conversationId, vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Zed", amount: "500" })));

      expect(result.transaction).toBeNull();
      expect(result.answer).toBe(incomeReask);
      expect(store.listTransactions(user.id)).toHaveLength(0);
    });

    // A refusal guard decides before any write of its turn. A refusal said anywhere in the open run, a quiet turn
    // included, means the turn that would write asks again and records nothing, and never writes and then denies it.
    const refusedAgain = "You said earlier that this payment didn't happen, so I haven't recorded anything.";
    const snapshot = () => ({
      transactions: store.listTransactions(user.id).map((item) => `${item.kind}:${item.amountMinor}:${item.description}`),
      bills: store.listBills(user.id).map((item) => `${item.name}:${item.amountMinor}`),
      debts: store.listDebts(user.id).map((item) => `${item.counterparty}:${item.amountMinor}:${item.status}`),
      balances: store.listAccounts(user.id).map((item) => item.balanceMinor),
    });
    const deniesAnyWrite = /didn't record anything|nothing was recorded|won't record the money/i;

    it("asks again and records nothing when yes answers the income question after a negation said in a quiet turn", async () => {
      const conversationId = await askZedPaidMe();
      await send("Actually, Zed did not pay me. List my debts.", conversationId, vi.fn());
      expect(lastStored(conversationId)).toMatchObject({ followup: "ordinary_income", readOnly: true });
      const before = snapshot();

      const result = await send("yes", conversationId, vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", category: "Other income" })));

      expect(result.transaction).toBeNull();
      expect(result.answer).toBe(`${refusedAgain} Say cancel to drop this question.`);
      expect(snapshot()).toEqual(before);
      expect(store.listTransactions(user.id)).toHaveLength(0);
      expect(store.listAccounts(user.id)[0].balanceMinor).toBe(0);
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "ordinary_income", readOnly: true });
      const cancelled = await send("cancel", conversationId, vi.fn());
      expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    });

    it("asks again and saves no bill or expense when a bill follows a negation said in a quiet turn", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      await send("Actually, Ana did not pay me. List my debts.", conversationId, vi.fn());
      const before = snapshot();

      const result = await send(billPrompt, conversationId, vi.fn(async () => billSpec()));

      expect(result.bill).toBeNull();
      expect(result.answer).toBe(`${refusedAgain} Say cancel to drop this question.`);
      expect(snapshot()).toEqual(before);
      expect(store.listBills(user.id)).toHaveLength(0);
      expect(store.listTransactions(user.id)).toHaveLength(0);
      expect(store.listDebts(user.id).find((item) => item.id === debt.id)?.amountMinor).toBe(100_000);
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount", readOnly: true });
    });

    // A reply that says nothing was recorded never coexists with a write committed in the same turn.
    describe("a denying reply never coexists with a committed write", () => {
      type Setup = () => Promise<{ conversationId: string; prompt: string; provider: ReturnType<typeof vi.fn> }>;
      const quietNegation = async (conversationId: string) => { await send("Actually, Ana did not pay me. List my debts.", conversationId, vi.fn()); };
      const cases: [string, Setup][] = [
        ["yes to ordinary income after a quiet negation", async () => {
          const conversationId = await askZedPaidMe();
          await send("Actually, Zed did not pay me. List my debts.", conversationId, vi.fn());
          return { conversationId, prompt: "yes", provider: vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500" })) };
        }],
        ["a bill after a quiet negation", async () => {
          const { conversationId } = await askAnaPaidMe();
          await quietNegation(conversationId);
          return { conversationId, prompt: billPrompt, provider: vi.fn(async () => billSpec()) };
        }],
        ["a bill update after a quiet negation", async () => {
          const { conversationId } = await askAnaPaidMe();
          seedNetflix();
          await quietNegation(conversationId);
          return { conversationId, prompt: "Update the Netflix bill amount to ₱599.", provider: vi.fn(async () => providerTool("update_bill", { name: "Netflix", amount: "599" })) };
        }],
        ["a bill in a message that carries the negation itself", async () => {
          const { conversationId } = await askAnaPaidMe();
          return { conversationId, prompt: `Ana has not paid me. ${billPrompt}`, provider: vi.fn(async () => billSpec()) };
        }],
        ["a repayment amount after a quiet negation", async () => {
          const { conversationId } = await askAnaPaidMe();
          await quietNegation(conversationId);
          return { conversationId, prompt: "500", provider: repaymentCall({ amount: "500" }) };
        }],
        ["a new debt after a quiet negation", async () => {
          const { conversationId } = await askAnaPaidMe();
          await quietNegation(conversationId);
          return { conversationId, prompt: "Bob owes me 300", provider: vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Bob", amount: "300" })) };
        }],
        ["a no to ordinary income with a bill in the same message", async () => {
          const conversationId = await askZedPaidMe();
          return { conversationId, prompt: `No. ${billPrompt}`, provider: vi.fn(async () => billSpec()) };
        }],
        ...["No, don't record this in Wallet or anywhere else.", "No, don't record it", "no, I changed my mind", "No, never mind"].map((reply): [string, Setup] => [`the refusal "${reply}" after an earlier yes that was held for an account`, async () => {
          const conversationId = await askZedPaidMe();
          const held = await send("yes, into my Nowhere account", conversationId, vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", account: "Nowhere" })));
          expect(held.transaction).toBeNull();
          expect(lastStored(conversationId).followup).toBe("account_or_date");
          return { conversationId, prompt: reply, provider: vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", account: "Wallet" })) };
        }]),
        ["a no to ordinary income after an earlier yes that was held for an account", async () => {
          const conversationId = await askZedPaidMe();
          const held = await send("yes", conversationId, vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500", account: "Nowhere" })));
          expect(held.transaction).toBeNull();
          expect(lastStored(conversationId).followup).toBe("account_or_date");
          return { conversationId, prompt: "no", provider: vi.fn(async () => providerTool("log_transaction", { kind: "income", amount: "500" })) };
        }],
      ];
      const seedNetflix = () => store.createBill(user.id, { name: "Netflix", amountMinor: 54_900, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2026-12-15", accountId: store.listAccounts(user.id)[0].id, categoryId: store.listCategories(user.id).find((category) => category.type === "expense")!.id });
      it("controls the bill update case: without a negation the same update changes the bill", async () => {
        const { conversationId } = await askAnaPaidMe();
        seedNetflix();
        const result = await send("Update the Netflix bill amount to ₱599.", conversationId, vi.fn(async () => providerTool("update_bill", { name: "Netflix", amount: "599" })));
        expect(result.bill).toMatchObject({ name: "Netflix", amountMinor: 59_900 });
      });
      it.each(cases)("%s", async (_name, setup) => {
        const { conversationId, prompt, provider } = await setup();
        const before = snapshot();

        const result = await send(prompt, conversationId, provider);

        const wrote = JSON.stringify(snapshot()) !== JSON.stringify(before);
        if (wrote) expect(result.answer).not.toMatch(deniesAnyWrite);
        if (deniesAnyWrite.test(result.answer)) expect(wrote).toBe(false);
      });
    });

    it("still records the repayment after a quiet turn that says nothing against it", async () => {
      const { debt, conversationId } = await askAnaPaidMe();
      await send("List my debts", conversationId, vi.fn());
      expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: "repayment_amount", readOnly: true });

      const result = await send("500", conversationId, repaymentCall({ amount: "500" }));

      expect(result.transaction).toMatchObject({ kind: "debt_repayment", debtId: debt.id, amountMinor: 50_000 });
    });
  });

  // A bill action that saves the bill answers the bill question it was asked, so that question ends with the save.
  const netflixPrompt = "I have a Netflix bill under Entertainment. It is monthly, starts today, and ends December 15.";
  async function askNetflixAmount() {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", { name: "Netflix", frequency: "monthly", category: "Entertainment" })));
    const asked = await (await POST(assistantRequest(netflixPrompt))).json();
    expect(asked.bill).toBeNull();
    expect(lastStored(asked.conversationId).followup).toBe("bill_amount");
    return asked.conversationId as string;
  }
  async function answerNetflixAmount(conversationId: string) {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", { name: "Netflix", amount: "549" })));
    const saved = await (await POST(assistantRequest("549", conversationId))).json();
    expect(saved.bill).toMatchObject({ name: "Netflix", amountMinor: 54_900 });
    expect(store.listTransactions(user.id)).toHaveLength(1);
    return saved;
  }

  it("ends the bill question when its answer saves the bill, so the next expense is recorded and not forced into the bill flow", async () => {
    const conversationId = await askNetflixAmount();
    await answerNetflixAmount(conversationId);
    expect(lastStored(conversationId)).toMatchObject({ role: "assistant", followup: null });

    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "200", description: "Lunch", kind: "expense", category: "Food" })));
    const lunch = await (await POST(assistantRequest("I spent 200 on lunch", conversationId))).json();

    expect(lunch.answer).not.toContain("already exists");
    expect(lunch.bill).toBeNull();
    expect(lunch.transaction).toMatchObject({ kind: "expense", amountMinor: 20_000, description: "Lunch" });
    expect(store.listBills(user.id)).toHaveLength(1);
    expect(store.listTransactions(user.id)).toHaveLength(2);
  });

  it("treats cancel as an ordinary prompt once the bill answer saved the bill, so the saved bill is not reported as dropped", async () => {
    const conversationId = await askNetflixAmount();
    await answerNetflixAmount(conversationId);
    const provider = vi.fn(async () => providerTool("ask_clarification", { question: "What would you like to cancel?" }));
    vi.stubGlobal("fetch", provider);

    const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(cancelled.answer).toBe("What would you like to cancel?");
    expect(cancelled.answer).not.toContain("dropped that question");
    expect(store.listBills(user.id)).toHaveLength(1);
    expect(store.listTransactions(user.id)).toHaveLength(1);
  });

  it("ends the question the saved bill answered but keeps a read-only turn's question pending in between", async () => {
    const conversationId = await askNetflixAmount();
    vi.stubGlobal("fetch", vi.fn());
    await POST(assistantRequest("List my debts", conversationId));
    expect(lastStored(conversationId).followup).toBe("bill_amount");

    await answerNetflixAmount(conversationId);

    expect(lastStored(conversationId).followup).toBeNull();
  });

  it("lets a bill action that asks its own question take over the pending slot, which is a known limit", async () => {
    const { conversationId } = await askAnaPaidMe();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("create_bill", { name: "Internet" })));

    const asked = await (await POST(assistantRequest("I have an Internet bill.", conversationId))).json();

    expect(asked.bill).toBeNull();
    expect(lastStored(conversationId).followup).toMatch(/^bill_/);
  });

  it("keeps the message that started a question through six re-asks, so 500 still repays Ana", async () => {
    const { debt, conversationId } = await askAnaPaidMe();
    for (let round = 0; round < 6; round++) {
      vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food" })));
      expect((await (await POST(assistantRequest("Coffee 120", conversationId))).json()).answer).toBe(amountReask);
    }
    expect(store.listTransactions(user.id)).toHaveLength(0);

    await expectAnaRepaid500(conversationId, debt.id);
  });

  // A run of 24 messages is the longest one a turn may extend. A run is never trimmed, so what the model reads is
  // what the user wrote, and a run that grew past the limit ends its question and writes nothing.
  const expiredReply = "That question has been open too long, so I dropped it. Nothing was recorded. Please send the details again.";
  const coffeeTool = () => providerTool("log_transaction", { amount: "120", description: "Coffee", kind: "expense", category: "Food" });
  async function askCoffeeThenAnaPaidMe() {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("ask_clarification", { question: "How much was the coffee?" })));
    const first = await (await POST(assistantRequest("Coffee"))).json();
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const asked = await (await POST(assistantRequest("Actually, Ana paid me", first.conversationId))).json();
    expect(asked.answer).toBe("What amount should I use for the repayment?");
    expect(lastStored(first.conversationId).followup).toBe("repayment_amount");
    return { debt, conversationId: first.conversationId as string };
  }
  async function reaskCoffee(conversationId: string, times: number) {
    for (let round = 0; round < times; round++) {
      vi.stubGlobal("fetch", vi.fn(async () => coffeeTool()));
      expect((await (await POST(assistantRequest("Coffee 120", conversationId))).json()).answer).toBe(amountReask);
    }
  }
  const messageCount = (conversationId: string) => store.getConversation(user.id, conversationId)!.messages.length;
  function expectNothingRecorded(debtId: string) {
    expect(store.listTransactions(user.id)).toEqual([]);
    expect(store.listDebts(user.id).find((item) => item.id === debtId)).toMatchObject({ amountMinor: 100_000, status: "open" });
  }

  it("still repays Ana with 500 after six re-asks of a run that held two questions, because no message of the run is dropped", async () => {
    const { debt, conversationId } = await askCoffeeThenAnaPaidMe();
    await reaskCoffee(conversationId, 6);
    expectNothingRecorded(debt.id);

    const provider = vi.fn(async () => expenseGuess500());
    vi.stubGlobal("fetch", provider);
    const result = await (await POST(assistantRequest("500", conversationId))).json();

    expect(sentTo(provider.mock.calls[0])).toContain("Actually, Ana paid me");
    expect(result.transaction).toMatchObject({ amountMinor: 50_000, kind: "debt_repayment", debtId: debt.id });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000 });
    expect(store.listTransactions(user.id)).toHaveLength(1);
  });

  it("still repays Ana with 500 when the run is two messages under the limit", async () => {
    const { debt, conversationId } = await askCoffeeThenAnaPaidMe();
    await reaskCoffee(conversationId, 9);
    expect(messageCount(conversationId)).toBe(22);

    vi.stubGlobal("fetch", vi.fn(async () => expenseGuess500()));
    const result = await (await POST(assistantRequest("500", conversationId))).json();

    expect(result.transaction).toMatchObject({ amountMinor: 50_000, kind: "debt_repayment", debtId: debt.id });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 50_000 });
  });

  it("ends the question without calling the model once re-asks fill the run, and a following prompt runs in a clean context", async () => {
    const { debt, conversationId } = await askCoffeeThenAnaPaidMe();
    await reaskCoffee(conversationId, 10);
    expect(messageCount(conversationId)).toBe(24);
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);

    const expired = await (await POST(assistantRequest("Coffee 120", conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(expired).toMatchObject({ answer: expiredReply, transaction: null, debt: null, undoUntil: null });
    expectNothingRecorded(debt.id);
    expect(messageCount(conversationId)).toBe(26);
    expect(lastStored(conversationId)).toMatchObject({ role: "assistant", content: expiredReply, followup: null });

    const next = vi.fn(async () => coffeeTool());
    vi.stubGlobal("fetch", next);
    const saved = await (await POST(assistantRequest("Coffee 120", conversationId))).json();

    expect(sentTo(next.mock.calls[0]).join(" ")).not.toContain("Ana paid me");
    expect(saved.transaction).toMatchObject({ kind: "expense", amountMinor: 12_000, description: "Coffee" });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000 });
  });

  it("records nothing for a 500 that arrives after the run expired, not an expense and not a repayment", async () => {
    const { debt, conversationId } = await askCoffeeThenAnaPaidMe();
    await reaskCoffee(conversationId, 10);
    const provider = vi.fn(async () => expenseGuess500());
    vi.stubGlobal("fetch", provider);

    const result = await (await POST(assistantRequest("500", conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(result.answer).toBe(expiredReply);
    expectNothingRecorded(debt.id);
  });

  it("still lets an exact cancel drop a question whose run is at the limit, with the cancel reply", async () => {
    const { debt, conversationId } = await askCoffeeThenAnaPaidMe();
    await reaskCoffee(conversationId, 10);
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);

    const cancelled = await (await POST(assistantRequest("cancel", conversationId))).json();

    expect(provider).not.toHaveBeenCalled();
    expect(cancelled.answer).toBe("Okay, I dropped that question. Nothing was recorded.");
    expect(lastStored(conversationId).followup).toBeNull();
    expectNothingRecorded(debt.id);
  });

  it("counts read-only turns that carry the question forward, so the twelfth debt list after Ana paid me expires it", async () => {
    const debt = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana" })));
    const { conversationId } = await (await POST(assistantRequest("Ana paid me"))).json();
    vi.stubGlobal("fetch", vi.fn());
    for (let round = 0; round < 11; round++) {
      await POST(assistantRequest("List my debts", conversationId));
      expect(lastStored(conversationId).followup).toBe("repayment_amount");
    }
    expect(messageCount(conversationId)).toBe(24);

    const expired = await (await POST(assistantRequest("List my debts", conversationId))).json();

    expect(expired.answer).toBe(expiredReply);
    expect(lastStored(conversationId).followup).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => expenseGuess500()));
    const next = await (await POST(assistantRequest("500", conversationId))).json();
    expect(next.transaction).toMatchObject({ kind: "expense", amountMinor: 50_000 });
    expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000 });
  });

  describe("a payer corrected inside a long run", () => {
    async function askAnaThenBob() {
      const ana = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Ana", amountMinor: 100_000 });
      const bob = store.createDebt(user.id, { direction: "owed_to_you", counterparty: "Bob", amountMinor: 100_000 });
      vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Ana", amount: "500", account: "Missing" })));
      const first = await (await POST(assistantRequest("Ana paid me 500 into my Missing account"))).json();
      const conversationId = first.conversationId as string;
      vi.stubGlobal("fetch", vi.fn(async () => providerTool("record_debt_payment", { counterparty: "Bob", amount: "500", account: "Missing" })));
      await POST(assistantRequest("Actually Bob paid me 500", conversationId));
      expect(lastStored(conversationId).followup).toBe("repayment_payer");
      await POST(assistantRequest("Bob", conversationId));
      expect(lastStored(conversationId).followup).toBe("account_or_date");
      return { ana, bob, conversationId };
    }
    async function listDebts(conversationId: string, times: number) {
      vi.stubGlobal("fetch", vi.fn());
      for (let round = 0; round < times; round++) await POST(assistantRequest("List my debts", conversationId));
    }

    it("does not repay Ana from Use Wallet after six debt lists, because the run still holds Bob's correction and selection", async () => {
      const { ana, bob, conversationId } = await askAnaThenBob();
      await listDebts(conversationId, 6);
      const provider = vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "income", category: "Other income", account: "Wallet" }));
      vi.stubGlobal("fetch", provider);

      const answered = await (await POST(assistantRequest("Use Wallet", conversationId))).json();

      expect(sentTo(provider.mock.calls[0])).toEqual(expect.arrayContaining(["Ana paid me 500 into my Missing account", "Actually Bob paid me 500", "Bob"]));
      expect(answered).toMatchObject({ answer: "Which person's open debt should I apply this payment to?", transaction: null });
      expect(store.listTransactions(user.id)).toEqual([]);
      for (const debt of [ana, bob]) expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
    });

    it("records nothing and leaves both debts when Use Wallet comes after the run expired", async () => {
      const { ana, bob, conversationId } = await askAnaThenBob();
      await listDebts(conversationId, 9);
      expect(messageCount(conversationId)).toBe(24);
      const provider = vi.fn(async () => providerTool("log_transaction", { amount: "500", kind: "income", category: "Other income", account: "Wallet" }));
      vi.stubGlobal("fetch", provider);

      const expired = await (await POST(assistantRequest("Use Wallet", conversationId))).json();

      expect(provider).not.toHaveBeenCalled();
      expect(expired.answer).toBe(expiredReply);
      expect(store.listTransactions(user.id)).toEqual([]);
      for (const debt of [ana, bob]) expect(store.listDebts(user.id).find((item) => item.id === debt.id)).toMatchObject({ amountMinor: 100_000, status: "open" });
    });
  });

  it("says the debt stays in Debts when the expired run had already saved one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerTool("log_debt", { direction: "owed_to_you", counterparty: "Cara", amount: "300" })));
    const saved = await (await POST(assistantRequest("Cara owes me 300"))).json();
    expect(lastStored(saved.conversationId)).toMatchObject({ followup: "debt_transaction" });
    vi.stubGlobal("fetch", vi.fn());
    for (let round = 0; round < 11; round++) await POST(assistantRequest("List my debts", saved.conversationId));
    expect(messageCount(saved.conversationId)).toBe(24);

    const expired = await (await POST(assistantRequest("List my debts", saved.conversationId))).json();

    expect(expired.answer).toBe("That question has been open too long, so I dropped it. The debt stays in Debts, and nothing was added to Transactions.");
    expect(store.listDebts(user.id)).toHaveLength(1);
    expect(store.listTransactions(user.id)).toEqual([]);
  });

  it("refuses an expiry turn when consent is withdrawn while the request body streams, and stores nothing", async () => {
    const { conversationId } = await askCoffeeThenAnaPaidMe();
    await reaskCoffee(conversationId, 10);
    const before = messageCount(conversationId);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        store.setAssistantConsent(user.id, null);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ prompt: "Coffee 120", conversationId })));
        controller.close();
      },
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn());

    const response = await POST(new Request("https://tally.test/api/assistant", {
      method: "POST", headers: { origin: "https://tally.test", "content-type": "application/json" }, body, ...{ duplex: "half" },
    }));

    expect(response.status).toBe(403);
    expect(messageCount(conversationId)).toBe(before);
  });
});
