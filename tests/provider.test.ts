import { afterEach, describe, expect, it, vi } from "vitest";
import { askProvider, minimalFollowUpContext } from "../src/lib/provider";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it("uses Codex-LB Chat Completions with only the two most recent context messages", async () => {
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
