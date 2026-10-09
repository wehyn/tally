import { createHash } from "node:crypto";
import { z } from "zod";
import { todayInManila } from "./dates";

const sensitive = (value: string) => value.replace(/[\r\n\t]/g, " ").trim();
export type ProviderConfig = { baseUrl: string; endpoint: string; model: string; apiKey: string; disclosure: string };

export function providerConfig(): ProviderConfig | null {
  const raw = process.env.CODEX_LB_BASE_URL?.trim();
  const model = process.env.CODEX_LB_MODEL?.trim();
  const apiKey = process.env.CODEX_LB_API_KEY?.trim();
  const disclosure = process.env.CODEX_LB_PRIVACY_DISCLOSURE?.trim();
  if (!raw || !model || !apiKey || !disclosure) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return { baseUrl, endpoint: baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`, model: sensitive(model), apiKey, disclosure: sensitive(disclosure) };
  } catch { return null; }
}
export function providerPublicConfig() {
  const config = providerConfig();
  return config ? { configured: true, baseUrl: config.baseUrl, model: config.model, disclosure: config.disclosure } : { configured: false, baseUrl: null, model: null, disclosure: null };
}

export function providerDisclosureHash(): string | null {
  const config = providerConfig();
  return config ? createHash("sha256").update(`${config.baseUrl}\\n${config.model}\\n${config.disclosure}`).digest("hex") : null;
}

const transactionTool = {
  type: "function",
  function: {
    name: "log_transaction",
    description: "Create one personal income or expense as soon as its amount and description are clear. Infer income from clearly incoming money; otherwise default to expense. Use an available category and account when the user names one.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["income", "expense"], description: "Infer from the message; default to expense unless it clearly describes incoming money." }, amount: { type: "string", description: "Positive PHP amount as a decimal string, e.g. 250 or 250.50" },
        description: { type: "string" }, category: { type: "string" }, account: { type: "string" }, date: { type: "string", description: "Optional YYYY-MM-DD only when the user specifies a different date; otherwise use the current Manila date supplied in the system message." },
      }, required: ["amount", "description"],
    },
  },
} as const;
const questionTool = {
  type: "function",
  function: {
    name: "finance_question",
    description: "Request app-calculated totals for the user's personal records. Default to month-to-date in Asia/Manila. Do not answer with invented values.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        start: { type: "string", description: "Inclusive YYYY-MM-DD; use month-to-date unless another period is requested." },
        end: { type: "string", description: "Inclusive YYYY-MM-DD, Manila local." },
        category: { type: "string", description: "Optional expense category name." },
      }, required: ["start", "end"],
    },
  },
} as const;
const clarificationTool = {
  type: "function",
  function: {
    name: "ask_clarification",
    description: "Ask only for an amount or description that genuinely cannot be inferred from the user's message and active follow-up. Never ask for transaction kind or date; default kind to expense unless money is clearly incoming, and use current Manila-local today.",
    parameters: { type: "object", additionalProperties: false, properties: { question: { type: "string" } }, required: ["question"] },
  },
} as const;
export type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
export type AssistantContextMessage = { role: "user" | "assistant"; content: string; needsFollowup?: boolean };
export function minimalFollowUpContext(messages: AssistantContextMessage[]): { role: "user" | "assistant"; content: string }[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.needsFollowup) return [];
  let lastCompletedAssistant = -1;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && !message.needsFollowup) {
      lastCompletedAssistant = index;
      break;
    }
  }
  return messages.slice(lastCompletedAssistant + 1).slice(-8)
    .map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
}

async function readProviderJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) throw new Error("Assistant provider response was too large.");
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Provider response is empty.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("Assistant provider response was too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && error.message === "Assistant provider response was too large.") throw error;
    throw new Error("Assistant provider returned an invalid or unreadable response.");
  }
}

export async function askProvider(input: { prompt: string; history?: { role: "user" | "assistant"; content: string }[] }): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const config = providerConfig();
  if (!config) throw new Error("Codex-LB is not fully configured. Ask the operator to configure the provider and its privacy disclosure.");
  const now = new Date();
  const today = todayInManila(now);
  const currentDateTime = new Intl.DateTimeFormat("en-PH", {
    dateStyle: "full", timeStyle: "short", timeZone: "Asia/Manila",
  }).format(now);
  const system = `You are Tally, a concise finance assistant. The user's currency is PHP. Current date and time in Asia/Manila: ${currentDateTime}. Today's date is ${today}. Use exactly one tool for each request. For a transaction with a clear amount and description, call log_transaction immediately; no confirmation. If kind is omitted or unclear, default to expense unless the message clearly describes incoming money (such as salary, money received, or earnings). Never ask for a transaction date: when the user gives no different date, use ${today}; “today” always means ${today}. Use another date only when the user explicitly states one. Infer the most fitting category from the description (for example, transportation is Transport) and use the default account/category when omitted. Preserve transaction details from the active follow-up context. Ask only if the amount or description truly cannot be inferred. For finance questions, call finance_question with requested inclusive dates or month-to-date by default; the app computes the answer. Never invent amounts or give unsupported recommendations. If a request is otherwise unclear, call ask_clarification with one concise question.`;
  const response = await fetch(config.endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [
      { role: "system", content: system },
      ...(input.history ?? []).slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 4000) })),
      { role: "user", content: input.prompt },
    ], tools: [transactionTool, questionTool, clarificationTool], tool_choice: "required" }),
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`Assistant provider returned HTTP ${response.status}.`);
  const data = await readProviderJson(response, 1_000_000);
  const parsed = z.object({ choices: z.array(z.object({ message: z.object({ tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }) })).min(1) }).safeParse(data);
  if (!parsed.success) throw new Error("Assistant provider returned an invalid tool response.");
  const call = parsed.data.choices[0].message.tool_calls?.[0];
  if (!call) throw new Error("Assistant provider did not return a supported action.");
  let args: Record<string, unknown>;
  try { const value: unknown = JSON.parse(call.function.arguments); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); args = value as Record<string, unknown>; }
  catch { throw new Error("Assistant provider returned malformed action data."); }
  return { name: call.function.name, args };
}
