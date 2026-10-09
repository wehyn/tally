"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, CalendarDays, Plus, Sparkles } from "lucide-react";
import { formatPHP } from "@/lib/money";
import { monthToDateRange, todayInManila } from "@/lib/dates";
import { LEDGER_UPDATED_EVENT } from "@/lib/client-events";
import type { Store } from "@/lib/store";

type Dashboard = ReturnType<Store["getDashboard"]>;
export function DashboardView({ initial, categories }: { initial: Dashboard; categories: ReturnType<Store["listCategories"]> }) {
  const [data, setData] = useState(initial); const [start, setStart] = useState(initial.start); const [end, setEnd] = useState(initial.end);
  const [description, setDescription] = useState(""); const [amount, setAmount] = useState(""); const [categoryId, setCategoryId] = useState(categories.find((item) => item.type === "expense" && item.name === "Other")?.id ?? categories.find((item) => item.type === "expense")?.id ?? "");
  const [saving, setSaving] = useState(false); const [notice, setNotice] = useState("");
  const totalBalance = useMemo(() => data.accounts.reduce((sum, account) => sum + account.balanceMinor, 0), [data.accounts]);
  useEffect(() => {
    const refreshLedger = () => {
      void fetch(`/api/dashboard?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
        .then(async (response) => { if (response.ok) setData(await response.json()); })
        .catch(() => undefined);
    };
    window.addEventListener(LEDGER_UPDATED_EVENT, refreshLedger);
    return () => window.removeEventListener(LEDGER_UPDATED_EVENT, refreshLedger);
  }, [start, end]);
  async function refresh(rangeStart = start, rangeEnd = end) {
    const response = await fetch(`/api/dashboard?start=${encodeURIComponent(rangeStart)}&end=${encodeURIComponent(rangeEnd)}`);
    const result = await response.json(); if (response.ok) setData(result);
  }
  async function submitQuick(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setNotice("");
    try {
      const account = data.accounts.find((item) => item.isDefault) ?? data.accounts[0];
      const category = categories.find((item) => item.id === categoryId);
      if (!account || !category) throw new Error("Add an account and category before recording.");
      const response = await fetch("/api/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: category.type, amount, accountId: account.id, categoryId: category.id, description, date: todayInManila() }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Could not save transaction.");
      setAmount(""); setDescription(""); setNotice("Added to your ledger."); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save transaction."); }
    finally { setSaving(false); }
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
        {data.accounts.length ? <form onSubmit={submitQuick} className="quick-form"><label className="field-label">Category<select required value={categoryId} onChange={e=>setCategoryId(e.target.value)}><option value="">Choose category</option>{categories.map(category=><option key={category.id} value={category.id}>{category.name} · {category.type}</option>)}</select></label><label className="field-label">Amount<input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="₱ 0.00"/></label><label className="field-label">Description (optional)<input maxLength={180} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Add a note"/></label><button className="button button-primary full-width" disabled={saving}>{saving?"Saving…":"Add to ledger"}</button>{notice&&<p className="form-notice" role="status">{notice}</p>}</form> : <div className="quick-empty"><span>Start with a financial account.</span><Link href="/accounts" className="button button-primary">Create account</Link></div>}
      </article>
    </section>
    <section className="dashboard-bottom-grid">
      <article className="panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest entries in your private ledger.</p></div><Link href="/transactions" className="quiet-link">All transactions</Link></div>
        {data.transactions.length ? <div className="activity-list">{data.transactions.slice(0,5).map((tx)=><div className="activity-row" key={tx.id}><div className={`activity-icon ${tx.kind}`}><span>{tx.kind==="income"?"↙":tx.kind==="expense"?"↗":"↔"}</span></div><div className="activity-copy"><strong>{tx.description||tx.categoryName||tx.kind}</strong><span>{tx.kind==="transfer"?`${tx.accountName} → ${tx.destinationAccountName}`:`${tx.categoryName} · ${tx.accountName}`}</span></div><div className="activity-right"><strong className={tx.kind==="income"?"positive":tx.kind==="expense"?"negative":""}>{tx.kind==="expense"?"−":tx.kind==="income"?"+":""}{formatPHP(tx.amountMinor)}</strong><span>{tx.date}{tx.time ? ` · ${tx.time}` : ""}</span></div></div>)}</div> : <div className="empty-inline"><div className="empty-spark">✦</div><div><strong>Your ledger starts here</strong><span>Add income, spending, or a transfer when you’re ready.</span></div></div>}
      </article>
      <article className="panel goals-panel"><div className="panel-heading"><div><h2>Shared goals</h2><p>Progress together, without sharing ledgers.</p></div><Link href="/goals" className="quiet-link">View goals</Link></div>
        {data.goals.length ? <div className="goal-mini-list">{data.goals.slice(0,3).map((goal)=><div className="goal-mini" key={goal.id}><div className="goal-mini-top"><strong>{goal.name}</strong><span>{formatPHP(goal.raisedMinor)} / {formatPHP(goal.targetMinor)}</span></div><div className="bar-track"><span className="bar-fill bar-goal" style={{width:`${Math.min(100,goal.raisedMinor/goal.targetMinor*100)}%`}}/></div><span className="goal-member-count">{goal.members.length} {goal.members.length===1?"member":"members"} · {goal.status==="completed"?"Complete":"Active"}</span></div>)}</div> : <div className="goals-empty"><span className="goal-orb">◎</span><strong>Save toward something together</strong><span>Create a shared goal and invite someone you trust.</span><Link href="/goals" className="quiet-link">Explore shared goals <span aria-hidden="true">→</span></Link></div>}
      </article>
    </section>
  </div>;
}
