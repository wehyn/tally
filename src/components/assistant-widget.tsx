"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import Link from "next/link";
import { Bot, Send, Sparkles, Undo2, X } from "lucide-react";
import { formatPHP } from "@/lib/money";
import { isUndoAvailable } from "@/lib/dates";
import { ASSISTANT_SETTINGS_UPDATED_EVENT, LEDGER_UPDATED_EVENT } from "@/lib/client-events";

type AssistantTransaction = {
  id: string;
  kind: string;
  amountMinor: number;
  description: string;
  date: string;
  time: string | null;
  categoryName: string | null;
  accountName: string;
  undoUntil: string | null;
};
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  transaction?: AssistantTransaction | null;
};
type AssistantMode = "closed" | "composing" | "chat";
type AssistantResponse = {
  error?: string;
  conversationId?: string;
  answer?: string;
  transaction?: AssistantTransaction | null;
  undoUntil?: string | null;
};

let messageSequence = 0;
function nextMessageId() {
  return `assistant-${Date.now()}-${++messageSequence}`;
}

export function AssistantWidget({ enabled, configured }: { enabled: boolean; configured: boolean }) {
  const [mode, setMode] = useState<AssistantMode>("closed");
  const [assistantEnabled, setAssistantEnabled] = useState(enabled);
  const [assistantConfigured, setAssistantConfigured] = useState(configured);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const panelOpen = mode === "chat" || (!assistantEnabled && mode === "composing");

  useEffect(() => {
    if (mode === "closed") return;
    let cancelled = false;
    void fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ assistantOptIn: boolean; provider: { configured: boolean } }>;
      })
      .then((settings) => {
        if (!settings || cancelled) return;
        setAssistantConfigured(settings.provider.configured);
        setAssistantEnabled(settings.assistantOptIn && settings.provider.configured);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    const refreshAssistantStatus = () => {
      void fetch("/api/settings", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          return response.json() as Promise<{ assistantOptIn: boolean; provider: { configured: boolean } }>;
        })
        .then((settings) => {
          if (!settings) return;
          setAssistantConfigured(settings.provider.configured);
          setAssistantEnabled(settings.assistantOptIn && settings.provider.configured);
        })
        .catch(() => undefined);
    };
    window.addEventListener(ASSISTANT_SETTINGS_UPDATED_EVENT, refreshAssistantStatus);
    return () => window.removeEventListener(ASSISTANT_SETTINGS_UPDATED_EVENT, refreshAssistantStatus);
  }, []);

  useEffect(() => {
    if (mode !== "chat") return;
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [mode, messages, busy]);

  useEffect(() => {
    if (mode === "composing" && assistantEnabled) promptField.current?.focus({ preventScroll: true });
  }, [mode, assistantEnabled]);

  useEffect(() => {
    const hasAvailableUndo = messages.some((message) => message.transaction?.undoUntil && isUndoAvailable(message.transaction.undoUntil, now || Date.now()));
    if (!hasAvailableUndo) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [messages, now]);

  function openAssistant() {
    if (!assistantEnabled) setMode("chat");
    else setMode(messages.length ? "chat" : "composing");
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || busy || !assistantEnabled) return;
    setMode("chat");
    setPrompt("");
    setNotice("");
    setMessages((previous) => [...previous, { id: nextMessageId(), role: "user", content: text }]);
    setBusy(true);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, ...(conversationId ? { conversationId } : {}) }),
      });
      const result = await response.json() as AssistantResponse;
      if (!response.ok) throw new Error(result.error ?? "Tally could not answer that.");
      if (!result.conversationId || !result.answer) throw new Error("Tally returned an incomplete answer. Please try again.");
      setConversationId(result.conversationId);
      setNow(Date.now());
      setMessages((previous) => [...previous, {
        id: nextMessageId(),
        role: "assistant",
        content: result.answer!,
        transaction: result.transaction ? { ...result.transaction, undoUntil: result.undoUntil ?? result.transaction.undoUntil } : null,
      }]);
      if (result.transaction) window.dispatchEvent(new Event(LEDGER_UPDATED_EVENT));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Tally could not answer that.");
    } finally {
      setBusy(false);
    }
  }

  async function undo(transactionId: string) {
    try {
      const response = await fetch(`/api/transactions/${transactionId}?undo=1`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setNotice(result.error ?? "Undo is no longer available.");
        return;
      }
      setMessages((previous) => previous.map((message) => message.transaction?.id === transactionId ? { ...message, transaction: null } : message));
      setNotice("Transaction undone.");
      window.dispatchEvent(new Event(LEDGER_UPDATED_EVENT));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Undo is no longer available.");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && mode !== "closed") {
      event.preventDefault();
      setMode("closed");
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return <div className={`assistant-widget ${mode}`}>
    <section id="assistant-widget-panel" className={`assistant-widget-panel ${assistantEnabled ? "has-composer" : ""}`} role="dialog" aria-modal="false" aria-label="Tally assistant" onKeyDown={(event) => { if (event.key === "Escape") setMode("closed"); }} hidden={!panelOpen}>
      <header className="assistant-widget-header">
        <span className="assistant-widget-mark"><Sparkles size={17}/></span>
        <div className="assistant-widget-title"><strong>Ask Tally</strong><span>{assistantEnabled ? "Your private ledger assistant" : "Optional assistant"}</span></div>
        <button type="button" className="assistant-widget-icon" aria-label="Close assistant" title="Close" onClick={() => setMode("closed")}><X size={16}/></button>
      </header>
      {assistantEnabled ? <>
        <div className="assistant-widget-messages" aria-label="Conversation" aria-live="polite">
          {messages.length ? messages.map((message) => <div className={`chat-bubble ${message.role}`} key={message.id}>
            {message.content}
            {message.transaction && <div className="chat-transaction">
              <strong>{formatPHP(message.transaction.amountMinor)} · {message.transaction.description || message.transaction.categoryName || message.transaction.kind}</strong>
              <span>{message.transaction.categoryName ?? message.transaction.kind} · {message.transaction.accountName} · {message.transaction.date}{message.transaction.time ? ` ${message.transaction.time}` : ""}</span>
              {message.transaction.undoUntil && isUndoAvailable(message.transaction.undoUntil, now) && <button type="button" className="undo-link" onClick={() => void undo(message.transaction!.id)}><Undo2 size={12} style={{ verticalAlign: "-2px" }}/> Undo · {Math.max(1, Math.ceil((Date.parse(message.transaction.undoUntil) - now) / 1000))}s</button>}
            </div>}
          </div>) : <div className="assistant-widget-empty"><span className="assistant-widget-mark"><Bot size={19}/></span><strong>What would you like to do?</strong><p>Ask about your recorded spending or describe a transaction.</p></div>}
          {busy && <div className="chat-bubble assistant">Checking your request…</div>}
          {notice && <p className="assistant-widget-notice" role="status">{notice}</p>}
          <div ref={bottom}/>
        </div>
      </> : <>
        <div className="assistant-widget-disabled">
          <p><strong>{assistantConfigured ? "The assistant is off until you opt in." : "The assistant is not configured."}</strong></p>
          <p>{assistantConfigured ? "Review the provider and retention disclosure in Settings, then enable the assistant if you agree." : "The instance operator must configure the provider and its privacy disclosure."}</p>
          <Link className="button button-small" href="/settings">Open Settings</Link>
        </div>
      </>}
    </section>
    {assistantEnabled ? <form className={`assistant-widget-composer ${mode}`} onSubmit={(event) => void send(event)}>
        <button type="button" className="assistant-widget-mode-button" aria-label={mode === "closed" ? "Open Tally assistant" : "Close message composer"} aria-expanded={panelOpen} aria-controls="assistant-widget-panel" hidden={mode === "chat"} onClick={() => mode === "closed" ? openAssistant() : setMode("closed")}>
          {mode === "closed" ? <Sparkles size={19}/> : <X size={16}/>}
        </button>
        <label className="sr-only" htmlFor="assistant-widget-prompt" hidden={mode === "closed"}>Message Tally</label>
        <textarea ref={promptField} id="assistant-widget-prompt" aria-controls="assistant-widget-panel" rows={1} maxLength={2000} value={prompt} disabled={busy} hidden={mode === "closed"} onChange={(event) => setPrompt(event.target.value)} onKeyDown={onKeyDown} placeholder="Ask Tally anything…"/>
        <button className="assistant-widget-send" hidden={mode === "closed"} disabled={busy || !prompt.trim()} aria-label="Send message" title="Send"><Send size={16}/></button>
      </form> : mode === "closed" ? <button type="button" className="assistant-widget-disabled-trigger" aria-label="Open Tally assistant" aria-expanded={panelOpen} aria-controls="assistant-widget-panel" onClick={() => setMode("chat")}><Sparkles size={19}/></button> : null}
  </div>;
}
