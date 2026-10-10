"use client";

import { useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, HandCoins, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { Debt, DebtDirection, DebtStatus } from "@/lib/store";
import { formatPHP, formatPHPFromMinorString, minorToInput } from "@/lib/money";

type DebtDraft = { direction: DebtDirection; counterparty: string; amount: string; dueDate: string; note: string };
type StatusFilter = DebtStatus | "all";
const blankDraft = (direction: DebtDirection = "owed_to_you"): DebtDraft => ({ direction, counterparty: "", amount: "", dueDate: "", note: "" });
const directions: DebtDirection[] = ["owed_to_you", "you_owe"];

function directionLabel(direction: DebtDirection) {
  return direction === "owed_to_you" ? "Owed to you" : "You owe";
}
function formatDueDate(value: string) {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeZone: "Asia/Manila" }).format(new Date(`${value}T12:00:00+08:00`));
}
function totalFor(debts: Debt[], direction: DebtDirection) {
  const total = debts
    .filter((debt) => debt.direction === direction && debt.status === "open")
    .reduce((sum, debt) => sum + BigInt(debt.amountMinor), 0n);
  return formatPHPFromMinorString(total.toString());
}

export function DebtsView({ initial }: { initial: Debt[] }) {
  const [debts, setDebts] = useState(initial);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Debt | null>(null);
  const [draft, setDraft] = useState<DebtDraft>(blankDraft());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function create(direction: DebtDirection = "owed_to_you") {
    setEditing(null);
    setDraft(blankDraft(direction));
    setError("");
    setDialogOpen(true);
  }

  function edit(debt: Debt) {
    setEditing(debt);
    setDraft({
      direction: debt.direction,
      counterparty: debt.counterparty,
      amount: minorToInput(debt.amountMinor),
      dueDate: debt.dueDate ?? "",
      note: debt.note,
    });
    setError("");
    setDialogOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(editing ? `/api/debts/${editing.id}` : "/api/debts", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, dueDate: draft.dueDate || null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save debt.");
      if (editing) setDebts((current) => current.map((debt) => debt.id === editing.id ? result.debt : debt));
      else setDebts((current) => [result.debt, ...current]);
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save debt.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(debt: Debt, status: DebtStatus) {
    setPendingId(debt.id);
    setError("");
    try {
      const response = await fetch(`/api/debts/${debt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not update debt.");
      setDebts((current) => current.map((item) => item.id === debt.id ? result.debt : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update debt.");
    } finally {
      setPendingId(null);
    }
  }

  async function remove(debt: Debt) {
    if (!window.confirm(`Delete the debt with ${debt.counterparty}?`)) return;
    setPendingId(debt.id);
    setError("");
    try {
      const response = await fetch(`/api/debts/${debt.id}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not delete debt.");
      setDebts((current) => current.filter((item) => item.id !== debt.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete debt.");
    } finally {
      setPendingId(null);
    }
  }

  return <div className="page-stack debts-page">
    <section className="page-heading-row page-heading-actions-only">
      <h1 className="sr-only">Debts</h1>
      <button className="button button-primary" onClick={() => create()}><Plus size={16}/> Add debt</button>
    </section>

    <section className="debt-summary-grid" aria-label="Outstanding debt totals">
      {directions.map((direction) => {
        const Icon = direction === "owed_to_you" ? ArrowDownLeft : ArrowUpRight;
        const outstandingCount = debts.filter((debt) => debt.direction === direction && debt.status === "open").length;
        return <article className="stat-card debt-summary-card" key={direction}>
          <div className={`debt-summary-icon ${direction}`}><Icon size={19}/></div>
          <div className="debt-summary-copy"><span>{directionLabel(direction)}</span><strong>{totalFor(debts, direction)}</strong><small>{outstandingCount} outstanding {outstandingCount === 1 ? "debt" : "debts"}</small></div>
        </article>;
      })}
    </section>

    <div className="debt-toolbar">
      <div className="debt-filter-group" role="group" aria-label="Filter debts by status">
        {(["open", "settled", "all"] as const).map((status) => <button key={status} className={`button button-small ${filter === status ? "button-secondary" : ""}`} aria-pressed={filter === status} onClick={() => setFilter(status)}>
          {status === "open" ? "Outstanding" : status === "settled" ? "Settled" : "All debts"}
        </button>)}
      </div>
      <span className="debt-count">{debts.filter((debt) => filter === "all" || debt.status === filter).length} records</span>
    </div>
    {error && !dialogOpen && <p className="error-text" role="alert">{error}</p>}

    <div className="debt-panels">
      {directions.map((direction) => {
        const sectionDebts = debts.filter((debt) => debt.direction === direction && (filter === "all" || debt.status === filter));
        const Icon = direction === "owed_to_you" ? ArrowDownLeft : ArrowUpRight;
        return <section className="panel debt-panel" key={direction} aria-labelledby={`debt-heading-${direction}`}>
          <div className="panel-heading debt-panel-heading">
            <div><h2 id={`debt-heading-${direction}`}>{directionLabel(direction)}</h2><p>{direction === "owed_to_you" ? "People who need to repay you" : "Amounts you need to repay"}</p></div>
            <button className="button button-small" onClick={() => create(direction)}><Plus size={14}/> Add</button>
          </div>
          <div className="debt-list">
            {sectionDebts.map((debt) => <article className={`debt-row ${debt.status}`} key={debt.id}>
              <div className={`debt-row-icon ${direction}`}><Icon size={17}/></div>
              <div className="debt-row-copy"><strong>{debt.counterparty}</strong><span>{debt.dueDate ? `Due ${formatDueDate(debt.dueDate)}` : "No due date"}{debt.note ? ` · ${debt.note}` : ""}</span></div>
              <div className="debt-row-total"><strong>{formatPHP(debt.amountMinor)}</strong><span className={`debt-status ${debt.status}`}>{debt.status === "open" ? "Outstanding" : "Settled"}</span></div>
              <div className="debt-row-actions">
                <button className="button button-small" disabled={pendingId === debt.id} aria-label={`Edit debt with ${debt.counterparty}`} onClick={() => edit(debt)}><Pencil size={13}/> Edit</button>
                <button className="button button-small" disabled={pendingId === debt.id} aria-label={debt.status === "open" ? `Mark debt with ${debt.counterparty} settled` : `Reopen debt with ${debt.counterparty}`} onClick={() => setStatus(debt, debt.status === "open" ? "settled" : "open")}>
                  {debt.status === "open" ? <><Check size={13}/> Settle</> : <><RotateCcw size={13}/> Reopen</>}
                </button>
                <button className="button button-small button-danger" disabled={pendingId === debt.id} aria-label={`Delete debt with ${debt.counterparty}`} onClick={() => remove(debt)}><Trash2 size={13}/></button>
              </div>
            </article>)}
            {!sectionDebts.length && <div className="panel-empty debt-empty"><HandCoins size={21}/><strong>{filter === "settled" ? "No settled debts here" : filter === "open" ? "Nothing outstanding" : "No debts yet"}</strong><span>{direction === "owed_to_you" ? "Add a debt someone owes you." : "Add a debt you need to repay."}</span><button className="button button-small" onClick={() => create(direction)}><Plus size={13}/> Add debt</button></div>}
          </div>
        </section>;
      })}
    </div>

    <p className="page-note debt-accounting-note">Debt records are separate from your financial accounts and transaction totals. Record repayments in Transactions when money actually moves.</p>

    {dialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialogOpen(false); }}>
      <section className="modal-card debt-modal" role="dialog" aria-modal="true" aria-labelledby="debt-dialog-title">
        <div className="modal-heading"><div><h2 id="debt-dialog-title">{editing ? "Edit debt" : "Add a debt"}</h2><p>Track the current amount. Repayments are recorded separately as transactions.</p></div><button className="modal-close" aria-label="Close" disabled={busy} onClick={() => setDialogOpen(false)}><X size={16}/></button></div>
        <form onSubmit={save}>
          <div className="form-grid">
            <label className="field-label span-2">Direction<select required value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value as DebtDirection })}><option value="owed_to_you">Owed to you</option><option value="you_owe">You owe</option></select></label>
            <label className="field-label span-2">Person or organization<input required maxLength={80} value={draft.counterparty} onChange={(event) => setDraft({ ...draft, counterparty: event.target.value })} placeholder="e.g. Mina"/></label>
            <label className="field-label">Current amount · PHP<input required inputMode="decimal" maxLength={24} value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} placeholder="1,250.00"/></label>
            <label className="field-label">Due date · optional<input type="date" value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}/></label>
            <label className="field-label span-2">Note · optional<textarea rows={3} maxLength={500} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Add context or a reminder"/></label>
          </div>
          {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}
          <div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={() => setDialogOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add debt"}</button></div>
        </form>
      </section>
    </div>}
  </div>;
}
