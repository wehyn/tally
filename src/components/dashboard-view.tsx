"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, CalendarDays, Plus, Sparkles } from "lucide-react";
import { formatPHP } from "@/lib/money";
import { isUndoAvailable, monthToDateRange, todayInManila } from "@/lib/dates";
import type { Store } from "@/lib/store";

type Dashboard = ReturnType<Store["getDashboard"]>;
type AssistantQuickResult = { conversationId: string; answer: string; transaction: { id: string; kind: string; amountMinor: number; description: string; categoryName: string | null; accountName: string; date: string } | null; undoUntil: string | null };
export function DashboardView({ initial, categories, assistantEnabled }: { initial: Dashboard; categories: ReturnType<Store["listCategories"]>; assistantEnabled: boolean }) {
  const [data, setData] = useState(initial); const [start, setStart] = useState(initial.start); const [end, setEnd] = useState(initial.end);
  const [description, setDescription] = useState(""); const [amount, setAmount] = useState(""); const [kind, setKind] = useState<"expense"|"income">("expense");
  const [saving, setSaving] = useState(false); const [notice, setNotice] = useState("");
  const [assistantPrompt, setAssistantPrompt] = useState(""); const [assistantSaving, setAssistantSaving] = useState(false);
  const [assistantResult, setAssistantResult] = useState<AssistantQuickResult | null>(null); const [assistantConversationId, setAssistantConversationId] = useState<string | null>(null); const [assistantNotice, setAssistantNotice] = useState(""); const [assistantTick, setAssistantTick] = useState(0);
  const totalBalance = useMemo(() => data.accounts.reduce((sum, account) => sum + account.balanceMinor, 0), [data.accounts]);
  useEffect(() => {
    if (!assistantResult?.undoUntil) return;
    const id = window.setInterval(() => setAssistantTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [assistantResult?.undoUntil]);
  async function refresh(rangeStart = start, rangeEnd = end) {
    const response = await fetch(`/api/dashboard?start=${encodeURIComponent(rangeStart)}&end=${encodeURIComponent(rangeEnd)}`);
    const result = await response.json(); if (response.ok) setData(result);
  }
  async function submitQuick(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setNotice("");
    try {
      const account = data.accounts.find((item) => item.isDefault) ?? data.accounts[0];
      const category = categories.find((item) => item.type === kind && item.name === (kind === "expense" ? "Other" : "Other income"));
      if (!account || !category) throw new Error("Add an account and category before recording.");
      const response = await fetch("/api/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, amount, accountId: account.id, categoryId: category.id, description, date: todayInManila() }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Could not save transaction.");
      setAmount(""); setDescription(""); setNotice("Added to your ledger."); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save transaction."); }
    finally { setSaving(false); }
  }
  async function submitAssistantQuick(e: React.FormEvent) {
    e.preventDefault(); const prompt = assistantPrompt.trim(); if (!prompt || assistantSaving || !assistantEnabled) return;
    setAssistantSaving(true); setAssistantNotice(""); setAssistantResult(null);
    try {
      const response = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, ...(assistantConversationId ? { conversationId: assistantConversationId } : {}) }) });
      const result: AssistantQuickResult = await response.json();
      if (!response.ok) throw new Error((result as unknown as { error?: string }).error ?? "Assistant could not complete that request.");
      setAssistantPrompt(""); setAssistantResult(result); setAssistantConversationId(result.conversationId); setAssistantTick(Date.now()); setAssistantNotice(result.answer);
      void refresh().catch(() => undefined);
    } catch (error) { setAssistantNotice(error instanceof Error ? error.message : "Assistant could not complete that request."); }
    finally { setAssistantSaving(false); }
  }
  async function undoAssistantQuickEntry(transactionId: string) {
    const response = await fetch(`/api/transactions/${transactionId}?undo=1`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) { setAssistantNotice(result.error ?? "Undo is no longer available."); return; }
    setAssistantResult((previous) => previous ? { ...previous, transaction: null, undoUntil: null } : previous);
    setAssistantNotice("Transaction undone."); void refresh().catch(() => undefined);
  }
  const maxBar = Math.max(...data.categorySpending.map((entry) => entry.amountMinor), 1);
  return <div className="page-stack">
    <section className="page-heading-row"><div><div className="eyebrow">PERSONAL LEDGER</div><h1>Your money, in view.</h1><p className="subtitle">A clear picture of what came in, what went out, and what’s next.</p></div><Link className="button button-primary" href="/transactions"><Plus size={17}/> Add transaction</Link></section>
    <section className="period-row"><div className="range-label"><CalendarDays size={16}/><span>Showing actuals</span><strong>{data.start} — {data.end}</strong></div><form className="date-range-form" onSubmit={(e)=>{e.preventDefault();refresh(start,end);}}><label><span className="sr-only">Start date</span><input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label><span>to</span><label><span className="sr-only">End date</span><input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label><button className="button button-small" type="submit">Apply</button><button className="button button-text button-small" type="button" onClick={()=>{const range=monthToDateRange();setStart(range.start);setEnd(range.end);refresh(range.start,range.end);}}>Month to date</button></form></section>
    <section className="stat-grid" aria-label="Period summary">
      <article className="stat-card balance-card"><div className="stat-top"><span>Total balance</span><span className="stat-icon green"><Sparkles size={17}/></span></div><strong className="stat-value">{formatPHP(totalBalance)}</strong><span className="stat-foot">Across {data.accounts.length} {data.accounts.length===1?"account":"accounts"}</span></article>
      <article className="stat-card"><div className="stat-top"><span>Income</span><span className="stat-icon green-light"><ArrowDownRight size={18}/></span></div><strong className="stat-value">{formatPHP(data.incomeMinor)}</strong><span className="stat-foot">Recorded in this period</span></article>
      <article className="stat-card"><div className="stat-top"><span>Spending</span><span className="stat-icon coral-light"><ArrowUpRight size={18}/></span></div><strong className="stat-value">{formatPHP(data.spendingMinor)}</strong><span className="stat-foot">Recorded in this period</span></article>
      <article className="stat-card"><div className="stat-top"><span>Net activity</span><span className="stat-icon violet-light"><ArrowLeftRight size={18}/></span></div><strong className={`stat-value ${data.incomeMinor-data.spendingMinor<0?"negative":""}`}>{formatPHP(data.incomeMinor-data.spendingMinor)}</strong><span className="stat-foot">Income less spending</span></article>
    </section>
    <section className="dashboard-main-grid">
      <article className="panel panel-large"><div className="panel-heading"><div><h2>Spending by category</h2><p>Expenses in the selected range; transfers and opening balances are excluded.</p></div><Link href="/transactions" className="quiet-link">View ledger</Link></div>
        {data.categorySpending.length ? <div className="category-bars">{data.categorySpending.slice(0,6).map((entry,index)=><div className="category-bar-row" key={entry.id}><div className="bar-label"><span>{entry.name}</span><strong>{formatPHP(entry.amountMinor)}</strong></div><div className="bar-track"><span className={`bar-fill bar-tone-${index%4}`} style={{width:`${Math.max(4,entry.amountMinor/maxBar*100)}%`}}/></div></div>)}</div> : <div className="empty-inline"><div className="empty-spark">✦</div><div><strong>No spending recorded yet</strong><span>Once you add expenses, category patterns will show here.</span></div></div>}
      </article>
      <article className="panel quick-entry-panel"><div className="panel-heading"><div><h2>Quick entry</h2><p>Save to your default account.</p></div><span className="quick-dot"/></div>
        {data.accounts.length ? <form onSubmit={submitQuick} className="quick-form"><div className="segmented"><button type="button" className={kind==="expense"?"selected":""} onClick={()=>setKind("expense")}>Expense</button><button type="button" className={kind==="income"?"selected":""} onClick={()=>setKind("income")}>Income</button></div><label className="field-label">Description<input required maxLength={180} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Coffee with Mara"/></label><label className="field-label">Amount<input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="₱ 0.00"/></label><button className="button button-primary full-width" disabled={saving}>{saving?"Saving…":"Add to ledger"}</button>{notice&&<p className="form-notice" role="status">{notice}</p>}</form> : <div className="quick-empty"><span>Start with a financial account.</span><Link href="/accounts" className="button button-primary">Create account</Link></div>}
        <div className="dashboard-assistant-entry"><div className="assistant-entry-heading"><Sparkles size={14}/><span>Describe it naturally</span></div>
          {assistantEnabled?<form className="assistant-entry-form" onSubmit={submitAssistantQuick}><label className="sr-only" htmlFor="dashboard-assistant-prompt">Describe a transaction or ask a finance question</label><textarea id="dashboard-assistant-prompt" rows={2} maxLength={2000} value={assistantPrompt} onChange={e=>setAssistantPrompt(e.target.value)} disabled={assistantSaving} placeholder="Jollibee lunch 250"/><button className="button button-small button-primary" disabled={assistantSaving||!assistantPrompt.trim()}>{assistantSaving?"Working…":"Ask Tally"}</button></form>:<div className="assistant-entry-disabled"><span>Optional hosted capture is off.</span><Link href="/settings" className="quiet-link">Review privacy settings →</Link></div>}
          {assistantNotice&&<p className="form-notice" role="status">{assistantNotice}{assistantResult&&<> <Link href="/assistant" className="quiet-link">Continue in Assistant →</Link></>}</p>}
          {assistantResult?.transaction&&<div className="assistant-quick-result"><strong>{formatPHP(assistantResult.transaction.amountMinor)} · {assistantResult.transaction.description}</strong><span>{assistantResult.transaction.categoryName??assistantResult.transaction.kind} · {assistantResult.transaction.accountName} · {assistantResult.transaction.date}</span>{assistantResult.undoUntil&&isUndoAvailable(assistantResult.undoUntil,assistantTick)&&<button className="undo-link" onClick={()=>void undoAssistantQuickEntry(assistantResult.transaction!.id)}><span aria-hidden="true">↶</span> Undo</button>}</div>}
        </div>
      </article>
    </section>
    <section className="dashboard-bottom-grid">
      <article className="panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest entries in your private ledger.</p></div><Link href="/transactions" className="quiet-link">All transactions</Link></div>
        {data.transactions.length ? <div className="activity-list">{data.transactions.slice(0,5).map((tx)=><div className="activity-row" key={tx.id}><div className={`activity-icon ${tx.kind}`}><span>{tx.kind==="income"?"↙":tx.kind==="expense"?"↗":"↔"}</span></div><div className="activity-copy"><strong>{tx.description}</strong><span>{tx.kind==="transfer"?`${tx.accountName} → ${tx.destinationAccountName}`:`${tx.categoryName} · ${tx.accountName}`}</span></div><div className="activity-right"><strong className={tx.kind==="income"?"positive":tx.kind==="expense"?"negative":""}>{tx.kind==="expense"?"−":tx.kind==="income"?"+":""}{formatPHP(tx.amountMinor)}</strong><span>{tx.date}</span></div></div>)}</div> : <div className="empty-inline"><div className="empty-spark">✦</div><div><strong>Your ledger starts here</strong><span>Add income, spending, or a transfer when you’re ready.</span></div></div>}
      </article>
      <article className="panel goals-panel"><div className="panel-heading"><div><h2>Shared goals</h2><p>Progress together, without sharing ledgers.</p></div><Link href="/goals" className="quiet-link">View goals</Link></div>
        {data.goals.length ? <div className="goal-mini-list">{data.goals.slice(0,3).map((goal)=><div className="goal-mini" key={goal.id}><div className="goal-mini-top"><strong>{goal.name}</strong><span>{formatPHP(goal.raisedMinor)} / {formatPHP(goal.targetMinor)}</span></div><div className="bar-track"><span className="bar-fill bar-goal" style={{width:`${Math.min(100,goal.raisedMinor/goal.targetMinor*100)}%`}}/></div><span className="goal-member-count">{goal.members.length} {goal.members.length===1?"member":"members"} · {goal.status==="completed"?"Complete":"Active"}</span></div>)}</div> : <div className="goals-empty"><span className="goal-orb">◎</span><strong>Save toward something together</strong><span>Create a shared goal and invite someone you trust.</span><Link href="/goals" className="quiet-link">Explore shared goals <span aria-hidden="true">→</span></Link></div>}
      </article>
    </section>
  </div>;
}
