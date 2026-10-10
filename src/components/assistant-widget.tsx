"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import Link from "next/link";
import { Bot, Send, Sparkles, Undo2, X } from "lucide-react";
import { formatPHP, minorToInput } from "@/lib/money";
import { isUndoAvailable } from "@/lib/dates";
import type { Debt } from "@/lib/store";
import { ASSISTANT_SETTINGS_UPDATED_EVENT, DEBTS_UPDATED_EVENT, LEDGER_UPDATED_EVENT } from "@/lib/client-events";
import { AssistantDatePicker, AssistantSelect } from "./assistant-transaction-controls";

type AssistantTransaction = {
  id: string;
  kind: "income" | "expense";
  amountMinor: number;
  accountId: string;
  description: string;
  date: string;
  time: string | null;
  categoryId: string;
  categoryName: string | null;
  accountName: string;
  undoUntil: string | null;
};
type AssistantAccount = { id: string; name: string };
type AssistantCategory = { id: string; name: string; type: "income" | "expense" };
type TransactionEdit = Partial<Pick<AssistantTransaction, "accountId" | "categoryId" | "date">>;
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
  debt?: Debt | null;
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
  const [transactionOptions, setTransactionOptions] = useState<{ accounts: AssistantAccount[]; categories: AssistantCategory[] } | null>(null);
  const [savingTransactionId, setSavingTransactionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const [openTransactionControl, setOpenTransactionControl] = useState<string | null>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const panelOpen = mode === "chat" || (!assistantEnabled && mode === "composing");
  const transactionIds = messages.flatMap((message) => message.transaction ? [message.transaction.id] : []).join(",");
  const hasTransaction = Boolean(transactionIds);

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
    if (!hasTransaction || transactionOptions) return;
    let cancelled = false;
    void Promise.all([fetch("/api/accounts", { cache: "no-store" }), fetch("/api/categories", { cache: "no-store" })])
      .then(async ([accountsResponse, categoriesResponse]) => {
        if (!accountsResponse.ok || !categoriesResponse.ok) throw new Error("Could not load transaction options.");
        const [accountResult, categoryResult] = await Promise.all([accountsResponse.json(), categoriesResponse.json()]) as [
          { accounts: AssistantAccount[] },
          { categories: AssistantCategory[] },
        ];
        if (!cancelled) setTransactionOptions({ accounts: accountResult.accounts, categories: categoryResult.categories });
      })
      .catch(() => { if (!cancelled) setNotice("Could not load categories and accounts for editing."); });
    return () => { cancelled = true; };
  }, [hasTransaction, transactionIds, transactionOptions]);

  useEffect(() => {
    const list = messageList.current;
    if (mode !== "chat" || !list) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [mode, messages, busy]);

  useEffect(() => {
    if (mode === "composing" && assistantEnabled) promptField.current?.focus({ preventScroll: true });
  }, [mode, assistantEnabled]);

  useEffect(() => {
    const undoDeadlines = messages.flatMap((message) => message.transaction?.undoUntil ? [message.transaction.undoUntil] : []);
    if (!undoDeadlines.some((deadline) => isUndoAvailable(deadline, Date.now()))) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!undoDeadlines.some((deadline) => isUndoAvailable(deadline, current))) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [messages]);

  function openAssistant() {
    if (!assistantEnabled) setMode("chat");
    else setMode(messages.length || window.matchMedia("(max-width: 900px)").matches ? "chat" : "composing");
  }

  function closeAssistant() {
    setOpenTransactionControl(null);
    setMode("closed");
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
      if (result.debt) window.dispatchEvent(new CustomEvent<Debt>(DEBTS_UPDATED_EVENT, { detail: result.debt }));
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
      setMessages((previous) => previous.filter((message) => message.transaction?.id !== transactionId));
      setNotice("Transaction undone.");
      window.dispatchEvent(new Event(LEDGER_UPDATED_EVENT));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Undo is no longer available.");
    }
  }

  async function updateTransaction(transaction: AssistantTransaction, changes: TransactionEdit) {
    if (savingTransactionId) return;
    const accountId = changes.accountId ?? transaction.accountId;
    const categoryId = changes.categoryId ?? transaction.categoryId;
    const account = transactionOptions?.accounts.find((item) => item.id === accountId);
    const category = transactionOptions?.categories.find((item) => item.id === categoryId && item.type === transaction.kind);
    if (!account || !category) {
      setNotice("Choose a valid category and account.");
      return;
    }
    const optimistic = { ...transaction, ...changes, accountId, accountName: account.name, categoryId, categoryName: category.name };
    setSavingTransactionId(transaction.id);
    setNotice("");
    setMessages((previous) => previous.map((message) => message.transaction?.id === transaction.id ? { ...message, transaction: optimistic } : message));
    try {
      const response = await fetch(`/api/transactions/${transaction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: transaction.kind,
          amount: minorToInput(transaction.amountMinor),
          accountId,
          categoryId,
          description: transaction.description,
          date: changes.date ?? transaction.date,
          time: transaction.time,
        }),
      });
      const result = await response.json() as { error?: string; transaction?: AssistantTransaction };
      if (!response.ok || !result.transaction) throw new Error(result.error ?? "Could not update transaction.");
      setMessages((previous) => previous.map((message) => message.transaction?.id === transaction.id ? { ...message, transaction: result.transaction! } : message));
      window.dispatchEvent(new Event(LEDGER_UPDATED_EVENT));
    } catch (error) {
      setMessages((previous) => previous.map((message) => message.transaction?.id === transaction.id ? { ...message, transaction } : message));
      setNotice(error instanceof Error ? error.message : "Could not update transaction.");
    } finally {
      setSavingTransactionId(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && mode !== "closed") {
      event.preventDefault();
      closeAssistant();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return <div className={`assistant-widget ${mode}`}>
    <section id="assistant-widget-panel" className={`assistant-widget-panel ${assistantEnabled ? "has-composer" : ""}`} role="dialog" aria-modal="false" aria-label="Tally assistant" onKeyDown={(event) => { if (event.key === "Escape") closeAssistant(); }} hidden={!panelOpen}>
      <header className="assistant-widget-header">
        <span className="assistant-widget-mark"><Sparkles size={17}/></span>
        <div className="assistant-widget-title"><strong>Ask Tally</strong><span>{assistantEnabled ? "Your private ledger assistant" : "Optional assistant"}</span></div>
        <button type="button" className="assistant-widget-icon" aria-label="Close assistant" title="Close" onClick={closeAssistant}><X size={16}/></button>
      </header>
      {assistantEnabled ? <>
        <div ref={messageList} className="assistant-widget-messages" aria-label="Conversation" aria-live="polite">
          {messages.length ? messages.map((message) => message.transaction ? <article className="chat-transaction-card" key={message.id} aria-label="Recorded transaction">
            <strong className={`chat-transaction-amount ${message.transaction.kind === "income" ? "positive" : "negative"}`}>{formatPHP(message.transaction.amountMinor)}</strong>
            <span className="chat-transaction-description">{message.transaction.description || "No description"}</span>
            <div className="chat-transaction-fields">
              <AssistantSelect
                label="Category"
                value={message.transaction.categoryId}
                options={[
                  { value: message.transaction.categoryId, label: message.transaction.categoryName ?? "Choose category" },
                  ...(transactionOptions?.categories.filter((category) => category.type === message.transaction!.kind && category.id !== message.transaction!.categoryId).map((category) => ({ value: category.id, label: category.name })) ?? []),
                ]}
                disabled={!transactionOptions}
                busy={savingTransactionId !== null}
                open={openTransactionControl === `${message.transaction.id}:category`}
                onOpenChange={(open) => setOpenTransactionControl(open ? `${message.transaction!.id}:category` : null)}
                onChange={(categoryId) => void updateTransaction(message.transaction!, { categoryId })}
              />
              <AssistantSelect
                label="Account"
                value={message.transaction.accountId}
                options={[
                  { value: message.transaction.accountId, label: message.transaction.accountName },
                  ...(transactionOptions?.accounts.filter((account) => account.id !== message.transaction!.accountId).map((account) => ({ value: account.id, label: account.name })) ?? []),
                ]}
                disabled={!transactionOptions}
                busy={savingTransactionId !== null}
                open={openTransactionControl === `${message.transaction.id}:account`}
                alignEnd
                onOpenChange={(open) => setOpenTransactionControl(open ? `${message.transaction!.id}:account` : null)}
                onChange={(accountId) => void updateTransaction(message.transaction!, { accountId })}
              />
              <AssistantDatePicker
                value={message.transaction.date}
                disabled={!transactionOptions}
                busy={savingTransactionId !== null}
                open={openTransactionControl === `${message.transaction.id}:date`}
                onOpenChange={(open) => setOpenTransactionControl(open ? `${message.transaction!.id}:date` : null)}
                onChange={(date) => void updateTransaction(message.transaction!, { date })}
              />
            </div>
            {savingTransactionId === message.transaction.id && <span className="chat-transaction-saving" role="status">Updating…</span>}
            {message.transaction.undoUntil && isUndoAvailable(message.transaction.undoUntil, now) && <button type="button" className="undo-link" disabled={savingTransactionId === message.transaction.id} onClick={() => void undo(message.transaction!.id)}><Undo2 size={12} style={{ verticalAlign: "-2px" }}/> Undo · {Math.max(1, Math.ceil((Date.parse(message.transaction.undoUntil) - now) / 1000))}s</button>}
          </article> : <div className={`chat-bubble ${message.role}`} key={message.id}>{message.content}</div>) : <div className="assistant-widget-empty"><span className="assistant-widget-mark"><Bot size={19}/></span><strong>What would you like to do?</strong><p>Ask about your money, describe a transaction, or record a debt.</p></div>}
          {busy && <div className="chat-bubble assistant">Checking your request…</div>}
          {notice && <p className="assistant-widget-notice" role="status">{notice}</p>}
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
        <button type="button" className="assistant-widget-mode-button" aria-label={mode === "closed" ? "Open Tally assistant" : "Close message composer"} aria-expanded={panelOpen} aria-controls="assistant-widget-panel" hidden={mode === "chat"} onClick={() => mode === "closed" ? openAssistant() : closeAssistant()}>
          {mode === "closed" ? <Sparkles size={19}/> : <X size={16}/>}
        </button>
        <label className="sr-only" htmlFor="assistant-widget-prompt" hidden={mode === "closed"}>Message Tally</label>
        <textarea ref={promptField} id="assistant-widget-prompt" aria-controls="assistant-widget-panel" rows={1} maxLength={2000} value={prompt} disabled={busy} hidden={mode === "closed"} onChange={(event) => setPrompt(event.target.value)} onKeyDown={onKeyDown} placeholder="Ask Tally anything…"/>
        <button className="assistant-widget-send" hidden={mode === "closed"} disabled={busy || !prompt.trim()} aria-label="Send message" title="Send"><Send size={16}/></button>
      </form> : mode === "closed" ? <button type="button" className="assistant-widget-disabled-trigger" aria-label="Open Tally assistant" aria-expanded={panelOpen} aria-controls="assistant-widget-panel" onClick={() => setMode("chat")}><Sparkles size={19}/></button> : null}
  </div>;
}
