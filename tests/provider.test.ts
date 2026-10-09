import { afterEach, describe, expect, it, vi } from "vitest";
import { askProvider, minimalFollowUpContext } from "../src/lib/provider";
import { todayInManila } from "../src/lib/dates";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("assistant data minimization", () => {
  it("keeps no conversation history unless the assistant is awaiting a follow-up", () => {
    const messages = [
      { role: "user" as const, content: "Earlier question" },
      { role: "assistant" as const, content: "Earlier private answer" },
    ];
    expect(minimalFollowUpContext(messages)).toEqual([]);
    expect(minimalFollowUpContext([
      ...messages,
      { role: "user" as const, content: "Lunch" },
      { role: "assistant" as const, content: "What amount for lunch?", needsFollowup: true },
    ])).toEqual([
      { role: "user", content: "Lunch" },
      { role: "assistant", content: "What amount for lunch?" },
    ]);
  });

  it("retains the original transaction details through a multi-turn follow-up", async () => {
    vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("CODEX_LB_MODEL", "test-model");
    vi.stubEnv("CODEX_LB_API_KEY", "test-api-key");
    vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");

    let requestBody: { messages: { role: string; content: string }[] } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: {
          name: "ask_clarification", arguments: JSON.stringify({ question: "Which amount?" }),
        } }] } }],
      }), { headers: { "content-type": "application/json" } });
    }));

    const pendingMessages = [
      { role: "user" as const, content: "transportation 500" },
      { role: "assistant" as const, content: "Was this an expense or income?", needsFollowup: true },
      { role: "user" as const, content: "expense" },
      { role: "assistant" as const, content: "What date should I use?", needsFollowup: true },
    ];
    await askProvider({ prompt: "today", history: minimalFollowUpContext(pendingMessages) });

    expect(requestBody?.messages.slice(1)).toEqual([
      ...pendingMessages.map(({ role, content }) => ({ role, content })),
      { role: "user", content: "today" },
    ]);
  });

  it("supplies the current Manila date and lets complete one-line expenses skip follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T08:00:00.000Z"));
    vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("CODEX_LB_MODEL", "test-model");
    vi.stubEnv("CODEX_LB_API_KEY", "test-api-key");
    vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");

    let requestBody: {
      messages: { role: string; content: string }[];
      tools: { function: { name: string; parameters: { required?: string[]; properties?: Record<string, { type?: string; pattern?: string }> } } }[];
    } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: {
          name: "log_transaction",
          arguments: JSON.stringify({ kind: "expense", amount: "500", description: "transportation" }),
        } }] } }],
      }), { headers: { "content-type": "application/json" } });
    }));

    await askProvider({ prompt: "transportation 500" });
    const system = requestBody?.messages[0].content ?? "";
    const transactionTool = requestBody?.tools.find(({ function: fn }) => fn.name === "log_transaction");

    expect(system).toContain(todayInManila());
    expect(system).toContain("Current date and time in Asia/Manila");
    expect(system.toLowerCase()).toContain("never ask for a transaction date");
    expect(system.toLowerCase()).toContain("never ask the user for a time");
    expect(system.toLowerCase()).toContain("current manila-local time");
    expect(system.toLowerCase()).toContain("default to expense");
    expect(transactionTool?.function.parameters.required).toEqual(["amount"]);
    expect(transactionTool?.function.parameters.properties?.time).toMatchObject({
      type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
    });
  });

  it("rejects chunked provider responses that exceed 1 MB", async () => {
    vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/backend-api/codex");
    vi.stubEnv("CODEX_LB_MODEL", "test-model");
    vi.stubEnv("CODEX_LB_API_KEY", "test-api-key");
    vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(600_000)));
        controller.enqueue(encoder.encode("x".repeat(600_000)));
        controller.close();
      },
    }))));

    await expect(askProvider({ prompt: "What did I spend?" })).rejects.toThrow(/response was too large/i);
  });

  it("uses Codex-LB Chat Completions with the active follow-up context", async () => {
    vi.stubEnv("CODEX_LB_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("CODEX_LB_MODEL", "test-model");
    vi.stubEnv("CODEX_LB_API_KEY", "test-api-key");
    vi.stubEnv("CODEX_LB_PRIVACY_DISCLOSURE", "Test-only disclosure");

    let requestUrl: string | undefined;
    let requestBody: {
      messages: { role: string; content: string }[];
      tools: { type: string; function: { name: string } }[];
      tool_choice: string;
    } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: {
          name: "ask_clarification", arguments: JSON.stringify({ question: "Which amount?" }),
        } }] } }],
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await askProvider({
      prompt: "250",
      history: minimalFollowUpContext([
        { role: "user", content: "Old private prompt" },
        { role: "assistant", content: "Old private answer" },
        { role: "user", content: "Lunch" },
        { role: "assistant", content: "What amount?", needsFollowup: true },
      ]),
    });

    expect(requestUrl).toBe("https://provider.example/v1/chat/completions");
    expect(requestBody?.messages[0].content).toContain("Tally");
    expect(requestBody?.messages.slice(1)).toEqual([
      { role: "user", content: "Lunch" },
      { role: "assistant", content: "What amount?" },
      { role: "user", content: "250" },
    ]);
    expect(requestBody?.tools.map(({ type, function: fn }) => ({ type, name: fn.name }))).toEqual([
      { type: "function", name: "log_transaction" },
      { type: "function", name: "finance_question" },
      { type: "function", name: "ask_clarification" },
    ]);
    expect(requestBody?.tool_choice).toBe("required");
    expect(result).toEqual({ name: "ask_clarification", args: { question: "Which amount?" } });
  });
});
