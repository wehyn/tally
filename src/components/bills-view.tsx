"use client";

import { useState } from "react";
import { Archive, CalendarDays, CreditCard, Droplet, Home, Music2, Pencil, Plus, Smartphone, Tv, Wifi, X, Zap, type LucideIcon } from "lucide-react";
import type { Account, Bill, BillIcon, Category } from "@/lib/store";
import { todayInManila } from "@/lib/dates";
import { formatPHP, minorToInput } from "@/lib/money";

const billIcons: { key: BillIcon; label: string; Icon: LucideIcon }[] = [
  { key: "calendar", label: "Calendar", Icon: CalendarDays }, { key: "home", label: "Home", Icon: Home },
  { key: "wifi", label: "Wi-Fi", Icon: Wifi }, { key: "phone", label: "Phone", Icon: Smartphone },
  { key: "electricity", label: "Electricity", Icon: Zap }, { key: "water", label: "Water", Icon: Droplet },
  { key: "tv", label: "TV", Icon: Tv }, { key: "music", label: "Music", Icon: Music2 },
  { key: "card", label: "Card", Icon: CreditCard },
];
type Draft = { name: string; amount: string; frequency: Bill["frequency"]; nextDueDate: string; accountId: string; categoryId: string; icon: BillIcon };
const billDateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const formatBillDate = (date: string) => billDateFormatter.format(new Date(`${date}T00:00:00Z`));
const blank = (accounts: Account[], categories: Category[]): Draft => ({
  name: "", amount: "", frequency: "monthly", nextDueDate: todayInManila(), accountId: accounts[0]?.id ?? "", categoryId: categories[0]?.id ?? "", icon: "calendar",
});

export function BillsView({ initialBills, accounts, categories }: { initialBills: Bill[]; accounts: Account[]; categories: Category[] }) {
  const [bills, setBills] = useState(initialBills);
  const [draft, setDraft] = useState<Draft>(blank(accounts, categories));
  const [editing, setEditing] = useState<Bill | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const today = todayInManila();
  const active = bills.filter((bill) => !bill.archivedAt).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
  const archived = bills.filter((bill) => bill.archivedAt).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));

  async function refresh() {
    const response = await fetch("/api/bills");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Could not load bills.");
    setBills(result.bills);
  }
  function create() { setEditing(null); setDraft(blank(accounts, categories)); setError(""); setOpen(true); }
  function edit(bill: Bill) {
    setEditing(bill);
    setDraft({ name: bill.name, amount: minorToInput(bill.amountMinor), frequency: bill.frequency, nextDueDate: bill.nextDueDate, accountId: bill.accountId, categoryId: bill.categoryId, icon: bill.icon });
    setError(""); setOpen(true);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(editing ? `/api/bills/${editing.id}` : "/api/bills", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save bill.");
      setOpen(false);
      if (result.bill) setBills((current) => current.some((bill) => bill.id === result.bill.id)
        ? current.map((bill) => bill.id === result.bill.id ? result.bill : bill)
        : [...current, result.bill]);
      setNotice(result.postingWarning ?? "");
      try { await refresh(); }
      catch { setNotice(result.postingWarning ?? "Bill saved, but the list could not refresh. Reload the page to confirm its latest status."); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save bill."); }
    finally { setBusy(false); }
  }
  async function archive(bill: Bill) {
    setError("");
    try {
      const response = await fetch(`/api/bills/${bill.id}/archive`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not archive bill.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not archive bill."); }
  }
  function list(items: Bill[], isArchived = false) {
    return items.length ? <div className="activity-list">{items.map((bill) => {
      const Icon = billIcons.find((option) => option.key === bill.icon)?.Icon ?? CalendarDays;
      const nextDueDate = formatBillDate(bill.nextDueDate);
      return <article className="activity-row" key={bill.id}>
        <div className="activity-icon"><Icon size={16}/></div>
        <div className="activity-copy"><strong>{bill.name}</strong><span>{bill.categoryName} · {bill.accountName}</span><span className={!isArchived && bill.nextDueDate <= today ? "badge badge-coral" : undefined}>{isArchived ? `Archived · next date was ${nextDueDate}` : bill.nextDueDate <= today ? `Posting pending · due ${nextDueDate}` : `Next due ${nextDueDate}`}</span></div>
        <div className="activity-right"><strong>{formatPHP(bill.amountMinor)}</strong><div className="table-actions"><button className="icon-button" aria-label={`Edit ${bill.name}`} onClick={() => edit(bill)}><Pencil size={14}/></button>{!isArchived && <button className="icon-button" aria-label={`Archive ${bill.name}`} onClick={() => void archive(bill)}><Archive size={14}/></button>}</div></div>
      </article>;
    })}</div> : <div className="panel-empty">{isArchived ? "No archived bills." : "No bills yet. Add a recurring payment or subscription."}</div>;
  }

  return <div className="page-stack">
    <section className="page-heading-row"><div><div className="eyebrow">RECURRING EXPENSES</div><h1>Bills</h1><p className="subtitle">Track subscriptions and scheduled payments.</p></div><button className="button button-primary" onClick={create}><Plus size={16}/> Add a bill</button></section>
    <div className="notice-box warning" role="note">Every bill due on or before today is automatically recorded as an expense, even if you have not confirmed payment. You can edit or delete the ledger transaction independently.</div>
    {notice && <div className="notice-box warning" role="status">{notice}</div>}
    {error && !open && <p className="error-text" role="alert">{error}</p>}
    <section className="panel"><div className="panel-heading"><div><h2>Upcoming</h2><p>Active bills, ordered by next due date.</p></div></div>{list(active)}</section>
    <section className="panel"><div className="panel-heading"><div><h2>Archived</h2><p>Archived bills stay visible and editable; they do not post.</p></div></div>{list(archived, true)}</section>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="bill-title">
      <div className="modal-heading"><div><h2 id="bill-title">{editing ? "Edit bill" : "Add a bill"}</h2><p>Set the next scheduled occurrence and saved expense details.</p></div><button className="modal-close" aria-label="Close" onClick={() => setOpen(false)}><X size={16}/></button></div>
      <form onSubmit={save}><div className="form-grid">
        <label className="field-label span-2">Bill name<input required autoFocus maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Internet subscription"/></label>
        <div className="field-label span-2"><span>Bill icon</span><div className="bill-icon-picker" role="group" aria-label="Bill icon">
          {billIcons.map(({ key, label, Icon }) => <button key={key} type="button" className="bill-icon-choice" aria-label={`Choose ${label} icon`} aria-pressed={draft.icon === key} onClick={() => setDraft({ ...draft, icon: key })}><Icon size={17}/><span>{label}</span></button>)}
        </div></div>
        <label className="field-label">Expected amount (PHP)<input required inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} placeholder="1,500.00"/></label>
        <label className="field-label">Frequency<select value={draft.frequency} onChange={(event) => setDraft({ ...draft, frequency: event.target.value as Draft["frequency"] })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label className="field-label">Next due date<input required type="date" value={draft.nextDueDate} onChange={(event) => setDraft({ ...draft, nextDueDate: event.target.value })}/></label>
        <label className="field-label">Account<select required value={draft.accountId} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label className="field-label">Expense category<select required value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      </div>{error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}<div className="modal-footer"><button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create bill"}</button></div></form>
    </section></div>}
  </div>;
}
