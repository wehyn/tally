#!/usr/bin/env node
// OpenAI-compatible Chat Completions stub that stands in for Codex-LB during verification.
// It never chooses tools itself: a journey queues the exact tool call the next request should return.
//   POST /v1/chat/completions  -> pops the queue (or returns ask_clarification when empty)
//   POST /__queue {name,args}  -> appends a scripted tool call
//   GET  /__health             -> {ok:true, queued:n}
// Every completion request body is appended to --log as one JSON line (evidence of what Tally sent).
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const arg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : fallback; };
const port = Number(arg("--port", "0"));
const log = arg("--log");
const queue = [];

const body = (req) => new Promise((resolve) => { let data = ""; req.on("data", (c) => { data += c; }); req.on("end", () => resolve(data)); });
const send = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__health") return send(res, 200, { ok: true, service: "tally-stub-provider", queued: queue.length });
  if (req.method === "POST" && req.url === "/__queue") {
    const call = JSON.parse(await body(req));
    if (typeof call.name !== "string" || typeof call.args !== "object") return send(res, 400, { error: "expected {name, args}" });
    queue.push(call);
    return send(res, 200, { ok: true, queued: queue.length });
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    const raw = await body(req);
    const call = queue.shift() ?? { name: "ask_clarification", args: { question: "Stub provider: no scripted tool call was queued." } };
    if (log) {
      const parsed = JSON.parse(raw);
      appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), authorization: req.headers.authorization ? "present" : "missing", model: parsed.model, tools: parsed.tools?.map((t) => t.function.name), messages: parsed.messages.filter((m) => m.role !== "system"), returned: call }) + "\n");
    }
    return send(res, 200, { id: "stub", object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_stub", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
  }
  send(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", function () { console.log(`STUB READY port=${this.address().port}`); });
