"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, CalendarDays, Landmark, Plus, Wallet } from "lucide-react";
import { CategoryGlyph } from "@/components/category-glyph";
import { formatPHP, formatPHPFromMinorString } from "@/lib/money";
import { monthToDateRange } from "@/lib/dates";
import { LEDGER_UPDATED_EVENT } from "@/lib/client-events";
import type { Store } from "@/lib/store";

type Dashboard = ReturnType<Store["getDashboard"]>;

const ASSET_COLORS = ["#256b51", "#367daf", "#8b7ab8", "#d28b50", "#c66f62", "#24a4a2", "#718078", "#ab86a6"];
const formatWeight = (basisPoints: number) => `${(basisPoints / 100).toFixed(2)}%`;

export function DashboardView({ initial }: { initial: Dashboard }) {
  const [data, setData] = useState(initial);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);

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
    const result = await response.json();
    if (response.ok) setData(result);
  }

  const totalBalanceMinorBigInt = data.accounts.reduce((total, account) => total + BigInt(account.balanceMinor), 0n);
  const maxSafeMinor = BigInt(Number.MAX_SAFE_INTEGER);
  if (totalBalanceMinorBigInt < -maxSafeMinor || totalBalanceMinorBigInt > maxSafeMinor) {
    throw new Error("Combined account balance exceeds the supported exact PHP minor-unit range.");
  }
  const totalBalanceMinor = Number(totalBalanceMinorBigInt);

  return <div className="page-stack">
    <section className="page-heading-row page-heading-actions-only"><h1 className="sr-only">Dashboard</h1><Link className="button button-primary" href="/transactions"><Plus size={17}/> Add transaction</Link></section>
    <section className="period-row"><div className="range-label"><CalendarDays size={16}/><span>Showing actuals</span><strong>{data.start} — {data.end}</strong></div><form className="date-range-form" onSubmit={(event) => { event.preventDefault(); void refresh(start, end); }}><label><span className="sr-only">Start date</span><input type="date" value={start} onChange={(event) => setStart(event.target.value)}/></label><span>to</span><label><span className="sr-only">End date</span><input type="date" value={end} onChange={(event) => setEnd(event.target.value)}/></label><button className="button button-small" type="submit">Apply</button><button className="button button-text button-small" type="button" onClick={() => { const range = monthToDateRange(); setStart(range.start); setEnd(range.end); void refresh(range.start, range.end); }}>Month to date</button></form></section>

    <section className="stat-grid dashboard-period-stats" aria-label="Period summary">
      <article className="stat-card"><div className="stat-top"><span>Total balance</span><span className="stat-icon green-light"><Wallet size={18}/></span></div><strong className={`stat-value ${totalBalanceMinor < 0 ? "negative" : ""}`}>{formatPHP(totalBalanceMinor)}</strong><span className="stat-foot">Across all accounts</span></article>
      <article className="stat-card"><div className="stat-top"><span>Income</span><span className="stat-icon green-light"><ArrowDownRight size={18}/></span></div><strong className="stat-value">{formatPHP(data.incomeMinor)}</strong><span className="stat-foot">Recorded in this period</span></article>
      <article className="stat-card"><div className="stat-top"><span>Spending</span><span className="stat-icon coral-light"><ArrowUpRight size={18}/></span></div><strong className="stat-value">{formatPHP(data.spendingMinor)}</strong><span className="stat-foot">Recorded in this period</span></article>
      <article className="stat-card"><div className="stat-top"><span>Net activity</span><span className="stat-icon violet-light"><ArrowLeftRight size={18}/></span></div><strong className={`stat-value ${data.incomeMinor - data.spendingMinor < 0 ? "negative" : ""}`}>{formatPHP(data.incomeMinor - data.spendingMinor)}</strong><span className="stat-foot">Income less spending</span></article>
    </section>

    <article className="panel assets-panel" aria-labelledby="assets-heading">
      <div className="panel-heading assets-heading"><div><h2 id="assets-heading">Assets <span>· {formatPHPFromMinorString(data.assetTotalMinor)}</span></h2><p>Current balances across your accounts.</p></div><Link href="/accounts" className="quiet-link">View accounts</Link></div>
      {data.accounts.length ? <>
        <div className="asset-composition" role="img" aria-label={`Account asset weights total ${formatPHPFromMinorString(data.assetTotalMinor)}`}>
          {data.accounts.map((account, index) => {
            const weight = data.assetWeights[account.id] ?? 0;
            return weight > 0 ? <span key={account.id} style={{ width: `${weight / 100}%`, background: ASSET_COLORS[index % ASSET_COLORS.length] }} title={`${account.name}: ${formatWeight(weight)}`}/> : null;
          })}
        </div>
        <div className="asset-legend" aria-label="Account weights">
          {data.accounts.map((account, index) => <span className="asset-legend-item" key={account.id}><i style={{ background: ASSET_COLORS[index % ASSET_COLORS.length] }}/><span>{account.name}</span><strong>{formatWeight(data.assetWeights[account.id] ?? 0)}</strong></span>)}
        </div>
        <div className="asset-table" role="table" aria-label="Balances and asset weight by account">
          <div className="asset-table-heading" role="row"><span role="columnheader">Name</span><span role="columnheader">Weight</span><span className="asset-value" role="columnheader">Value</span></div>
          {data.accounts.map((account, index) => {
            const weight = data.assetWeights[account.id] ?? 0;
            const AccountIcon = account.type === "cash" ? Wallet : Landmark;
            return <div className="asset-account-row" role="row" key={account.id}>
              <div className="asset-account-name" role="cell"><span className="asset-account-mark" style={{ color: ASSET_COLORS[index % ASSET_COLORS.length] }}><AccountIcon size={16}/></span><span><strong>{account.name}</strong><small>{account.type === "cash" ? "Cash" : "Bank account"}</small></span></div>
              <div className="asset-weight-cell" role="cell"><span className="asset-weight-track" aria-hidden="true"><i style={{ width: `${weight / 100}%`, background: ASSET_COLORS[index % ASSET_COLORS.length] }}/></span><strong>{formatWeight(weight)}</strong></div>
              <strong className="asset-value" role="cell">{formatPHP(account.balanceMinor)}</strong>
            </div>;
          })}
        </div>
        <p className="asset-footnote">Weights are based on positive balances. Zero and negative balances remain visible but are excluded from total assets.</p>
      </> : <div className="asset-empty"><span className="asset-empty-icon"><Wallet size={20}/></span><strong>Your accounts will appear here</strong><span>Add a cash or bank account to start tracking assets.</span><Link href="/accounts" className="button button-primary">Create account</Link></div>}
    </article>

    <section className="dashboard-bottom-grid">
      <article className="panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest entries in your private ledger.</p></div><Link href="/transactions" className="quiet-link">All transactions</Link></div>
        {data.transactions.length ? <div className="activity-list">{data.transactions.slice(0, 5).map((transaction) => <div className="activity-row" key={transaction.id}><div className={`activity-icon ${transaction.kind}`}>{transaction.kind === "transfer" ? <ArrowLeftRight size={16}/> : <CategoryGlyph icon={transaction.categoryIcon} size={16}/>}</div><div className="activity-copy"><strong>{transaction.description || transaction.categoryName || transaction.kind}</strong><span>{transaction.kind === "transfer" ? `${transaction.accountName} → ${transaction.destinationAccountName}` : `${transaction.categoryName} · ${transaction.accountName}`}</span></div><div className="activity-right"><strong className={transaction.kind === "income" ? "positive" : transaction.kind === "expense" ? "negative" : ""}>{transaction.kind === "expense" ? "−" : transaction.kind === "income" ? "+" : ""}{formatPHP(transaction.amountMinor)}</strong><span>{transaction.date}{transaction.time ? ` · ${transaction.time}` : ""}</span></div></div>)}</div> : <div className="empty-inline"><div className="empty-spark">✦</div><div><strong>Your ledger starts here</strong><span>Add income, spending, or a transfer when you’re ready.</span></div></div>}
      </article>
      <article className="panel goals-panel"><div className="panel-heading"><div><h2>Shared goals</h2><p>Progress together, without sharing ledgers.</p></div><Link href="/goals" className="quiet-link">View goals</Link></div>
        {data.goals.length ? <div className="goal-mini-list">{data.goals.slice(0, 3).map((goal) => <div className="goal-mini" key={goal.id}><div className="goal-mini-top"><strong>{goal.name}</strong><span>{formatPHP(goal.raisedMinor)} / {formatPHP(goal.targetMinor)}</span></div><div className="bar-track"><span className="bar-fill bar-goal" style={{ width: `${Math.min(100, goal.raisedMinor / goal.targetMinor * 100)}%` }}/></div><span className="goal-member-count">{goal.members.length} {goal.members.length === 1 ? "member" : "members"} · {goal.status === "completed" ? "Complete" : "Active"}</span></div>)}</div> : <div className="goals-empty"><span className="goal-orb">◎</span><strong>Save toward something together</strong><span>Create a shared goal and invite someone you trust.</span><Link href="/goals" className="quiet-link">Explore shared goals <span aria-hidden="true">→</span></Link></div>}
      </article>
    </section>
  </div>;
}
