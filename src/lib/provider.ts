import { createHash } from "node:crypto";
import { z } from "zod";

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
    description: "Create one complete personal income or expense. Ask a clarification instead if amount, kind, or description is missing. Use an available category and account when the user names one.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["income", "expense"] }, amount: { type: "string", description: "Positive PHP amount as a decimal string, e.g. 250 or 250.50" },
        description: { type: "string" }, category: { type: "string" }, account: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD or use the user's Manila-local today" },
      }, required: ["kind", "amount", "description"],
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
    description: "Ask only for information required to complete the user's request that cannot be inferred.",
    parameters: { type: "object", additionalProperties: false, properties: { question: { type: "string" } }, required: ["question"] },
  },
} as const;
export type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
export type AssistantContextMessage = { role: "user" | "assistant"; content: string; needsFollowup?: boolean };
export function minimalFollowUpContext(messages: AssistantContextMessage[]): { role: "user" | "assistant"; content: string }[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.needsFollowup) return [];
  return messages.slice(-2).map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
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
  const system = `You are Tally, a concise finance assistant. The user's timezone is Asia/Manila and currency is PHP. Use exactly one tool for each request. For complete income or expense capture, call log_transaction immediately; do not ask confirmation. Copy an account or category name only when the user explicitly provides it; the app validates it against that user's private settings and chooses defaults when omitted. The user may omit account, category, or date (the app uses Manila-local today). Ask only for truly missing kind, amount, or description. For finance questions, call finance_question with requested inclusive dates or month-to-date by default; the app computes the answer. Never invent amounts or give unsupported recommendations. If the request is unclear or missing required information, call ask_clarification with one concise question.`;
  const response = await fetch(config.endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [
      { role: "system", content: system },
      ...(input.history ?? []).slice(-2).map(({ role, content }) => ({ role, content: content.slice(0, 4000) })),
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
