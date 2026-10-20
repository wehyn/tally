"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Archive, CalendarDays, CarFront, ChevronDown, Cloud, CreditCard, Droplet, Fuel, GraduationCap, Dumbbell, Home, Music2, Pencil, Plus, ShieldCheck, ShoppingBag, Smartphone, Stethoscope, Trash2, Tv, Wifi, X, Zap, type LucideIcon } from "lucide-react";
import { BILL_ICON_LOGO_PATHS, DEFAULT_BILL_ICON_BACKGROUND_COLOR, DEFAULT_BILL_ICON_FOREGROUND_COLOR, selectBillIconPreset, type BillIcon } from "@/lib/bill-icons";
import type { Account, Bill, Category } from "@/lib/store";
import { todayInManila } from "@/lib/dates";
import { formatPHP, minorToInput } from "@/lib/money";
import { BILLS_UPDATED_EVENT } from "@/lib/client-events";
import { ModalPresence } from "./modal-presence";
import { useAddIntent } from "@/lib/add-intent";

const billIcons: { key: BillIcon; label: string; Icon?: LucideIcon }[] = [
  { key: "calendar", label: "Calendar", Icon: CalendarDays }, { key: "home", label: "Home", Icon: Home },
  { key: "wifi", label: "Wi-Fi", Icon: Wifi }, { key: "phone", label: "Phone", Icon: Smartphone },
  { key: "electricity", label: "Electricity", Icon: Zap }, { key: "water", label: "Water", Icon: Droplet },
  { key: "tv", label: "TV", Icon: Tv }, { key: "music", label: "Music", Icon: Music2 },
  { key: "card", label: "Card", Icon: CreditCard }, { key: "netflix", label: "Netflix" },
  { key: "shopee", label: "Shopee" }, { key: "pldt", label: "PLDT" },
  { key: "gym", label: "Gym", Icon: Dumbbell }, { key: "streaming", label: "Streaming", Icon: Tv },
  { key: "shopping", label: "Shopping", Icon: ShoppingBag }, { key: "transport", label: "Transport", Icon: CarFront },
  { key: "insurance", label: "Insurance", Icon: ShieldCheck }, { key: "gas", label: "Gas", Icon: Fuel },
  { key: "medical", label: "Medical", Icon: Stethoscope }, { key: "school", label: "School", Icon: GraduationCap },
  { key: "cloud", label: "Cloud storage", Icon: Cloud }, { key: "trash", label: "Waste collection", Icon: Trash2 },
];
type BillIconGlyphProps = { icon: BillIcon; emoji?: string | null; size?: number };
function BillIconGlyph({ icon, emoji, size = 17 }: BillIconGlyphProps) {
  if (emoji) return <span className="bill-icon-emoji" aria-hidden="true">{emoji}</span>;
  const logoPath = BILL_ICON_LOGO_PATHS[icon];
  if (logoPath) return <Image src={logoPath} alt="" className="bill-brand-logo" width={size} height={size} unoptimized style={{ objectFit: "contain" }}/>;
  const option = billIcons.find((entry) => entry.key === icon);
  const Icon = option?.Icon ?? CalendarDays;
  return <Icon size={size} aria-hidden="true"/>;
}
const defaultIconStyle = { color: DEFAULT_BILL_ICON_FOREGROUND_COLOR, backgroundColor: DEFAULT_BILL_ICON_BACKGROUND_COLOR };
type Draft = {
  name: string; amount: string; frequency: Bill["frequency"]; nextDueDate: string; endDate: string; accountId: string; categoryId: string;
  icon: BillIcon; iconEmoji: string; iconForegroundColor: string; iconBackgroundColor: string;
};
const billDateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const formatBillDate = (date: string) => billDateFormatter.format(new Date(`${date}T00:00:00Z`));
const blank = (accounts: Account[], categories: Category[]): Draft => ({
  name: "", amount: "", frequency: "monthly", nextDueDate: todayInManila(), endDate: "", accountId: accounts[0]?.id ?? "", categoryId: categories[0]?.id ?? "",
  icon: "calendar", iconEmoji: "", iconForegroundColor: DEFAULT_BILL_ICON_FOREGROUND_COLOR, iconBackgroundColor: DEFAULT_BILL_ICON_BACKGROUND_COLOR,
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

  const refresh = useCallback(async () => {
    const response = await fetch("/api/bills");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Could not load bills.");
    setBills(result.bills);
  }, []);
  useEffect(() => {
    const refreshAfterAssistantBill = () => { void refresh().catch(() => undefined); };
    window.addEventListener(BILLS_UPDATED_EVENT, refreshAfterAssistantBill);
    return () => window.removeEventListener(BILLS_UPDATED_EVENT, refreshAfterAssistantBill);
  }, [refresh]);
  function create() { setEditing(null); setDraft(blank(accounts, categories)); setError(""); setOpen(true); }
  useAddIntent("bill", create);
  function edit(bill: Bill) {
    setEditing(bill);
    setDraft({
      name: bill.name, amount: minorToInput(bill.amountMinor), frequency: bill.frequency, nextDueDate: bill.nextDueDate, endDate: bill.endDate ?? "",
      accountId: bill.accountId, categoryId: bill.categoryId, icon: bill.icon, iconEmoji: bill.iconEmoji ?? "",
      iconForegroundColor: bill.iconForegroundColor, iconBackgroundColor: bill.iconBackgroundColor,
    });
    setError(""); setOpen(true);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(editing ? `/api/bills/${editing.id}` : "/api/bills", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          ...draft, endDate: draft.endDate || null, iconEmoji: draft.iconEmoji || null, ...(editing ? { expectedNextDueDate: editing.nextDueDate } : {}),
        }),
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
      const nextDueDate = formatBillDate(bill.nextDueDate);
      const ended = Boolean(bill.endDate && bill.nextDueDate > bill.endDate);
      const postingPending = !isArchived && !ended && bill.nextDueDate <= today;
      return <article className="activity-row" key={bill.id}>
        <div className="activity-icon bill-row-icon" style={{ color: bill.iconForegroundColor, backgroundColor: bill.iconBackgroundColor }}><BillIconGlyph icon={bill.icon} emoji={bill.iconEmoji} size={16}/></div>
        <div className="activity-copy"><strong>{bill.name}</strong><span>{bill.categoryName} · {bill.accountName}</span><span className={postingPending ? "badge badge-coral" : undefined}>{isArchived ? `Archived · next date was ${nextDueDate}` : ended ? "Ended" : postingPending ? `Posting pending · due ${nextDueDate}` : `Next due ${nextDueDate}`}</span>{bill.endDate && <span>{ended ? isArchived ? "Ended" : "End date" : "Ends"} {formatBillDate(bill.endDate)}</span>}</div>
        <div className="activity-right"><strong>{formatPHP(bill.amountMinor)}</strong><div className="table-actions"><button className="icon-button" aria-label={`Edit ${bill.name}`} onClick={() => edit(bill)}><Pencil size={14}/></button>{!isArchived && <button className="icon-button" aria-label={`Archive ${bill.name}`} onClick={() => void archive(bill)}><Archive size={14}/></button>}</div></div>
      </article>;
    })}</div> : <div className="panel-empty">{isArchived ? "No archived bills." : "No bills yet. Add a recurring payment or subscription."}</div>;
  }

  return <div className="page-stack">
    <section className="page-heading-row"><h1>Bills</h1><button className="button button-primary" onClick={create}><Plus size={16}/> Add a bill</button></section>
    {notice && <div className="notice-box warning" role="status">{notice}</div>}
    {error && !open && <p className="error-text" role="alert">{error}</p>}
    <section className="panel"><div className="panel-heading"><div><h2>Upcoming</h2><p>Active bills, ordered by next due date.</p></div></div>{list(active)}</section>
    <details className="panel archived-disclosure"><summary className="panel-heading"><div><h2>Archived</h2><p>Archived bills stay visible and editable; they do not post.</p></div><ChevronDown className="archived-chevron" size={16} aria-hidden="true"/></summary>{list(archived, true)}</details>
    <ModalPresence open={open} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="bill-title">
      <div className="modal-heading"><div><h2 id="bill-title">{editing ? "Edit bill" : "Add a bill"}</h2><p>Set the next scheduled occurrence and saved expense details.</p></div><button className="modal-close" aria-label="Close" onClick={() => setOpen(false)}><X size={16}/></button></div>
      <form onSubmit={save}><div className="form-grid">
        <label className="field-label span-2">Bill name<input required autoFocus maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Internet subscription"/></label>
        <div className="field-label span-2"><span>Bill icon</span><div className="bill-icon-picker" role="group" aria-label="Bill icon">
          {billIcons.map(({ key, label }) => <button key={key} type="button" className="bill-icon-choice" aria-label={`Choose ${label} icon`} aria-pressed={draft.icon === key} onClick={() => setDraft(selectBillIconPreset(draft, key))} style={draft.icon === key ? { color: draft.iconForegroundColor, backgroundColor: draft.iconBackgroundColor } : defaultIconStyle}><BillIconGlyph icon={key}/></button>)}
        </div></div>
        <div className="bill-icon-customize span-2">
          <div className="bill-icon-preview" role="img" aria-label="Selected bill icon" style={{ color: draft.iconForegroundColor, backgroundColor: draft.iconBackgroundColor }}><BillIconGlyph icon={draft.icon} emoji={draft.iconEmoji}/></div>
          <label className="field-label bill-icon-emoji-field">Custom emoji<input type="text" maxLength={40} value={draft.iconEmoji} onChange={(event) => setDraft({ ...draft, iconEmoji: event.target.value })} placeholder="Optional"/></label>
          <label className="field-label bill-icon-color-field">Foreground<input type="color" value={draft.iconForegroundColor} onChange={(event) => setDraft({ ...draft, iconForegroundColor: event.target.value })}/></label>
          <label className="field-label bill-icon-color-field">Background<input type="color" value={draft.iconBackgroundColor} onChange={(event) => setDraft({ ...draft, iconBackgroundColor: event.target.value })}/></label>
        </div>
        <label className="field-label">Expected amount (PHP)<input required inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} placeholder="1,500.00"/></label>
        <label className="field-label">Frequency<select value={draft.frequency} onChange={(event) => setDraft({ ...draft, frequency: event.target.value as Draft["frequency"] })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label className="field-label">Next due date<input required type="date" value={draft.nextDueDate} onChange={(event) => setDraft({ ...draft, nextDueDate: event.target.value })}/></label>
        <label className="field-label">End date (optional)<input name="endDate" type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}/></label>
        <label className="field-label">Account<select required value={draft.accountId} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label className="field-label">Expense category<select required value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      </div>{error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}<div className="modal-footer"><button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create bill"}</button></div></form>
    </section></ModalPresence>
  </div>;
}
