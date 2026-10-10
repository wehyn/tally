"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Landmark, Pencil, Plus, Star, Trash2, Wallet, X } from "lucide-react";
import type { Account, Transaction } from "@/lib/store";
import { todayInManila, timeInManila } from "@/lib/dates";
import { formatPHP, minorToInput } from "@/lib/money";
import { LEDGER_UPDATED_EVENT } from "@/lib/client-events";

type AccountDraft = { name: string; type: "cash" | "bank"; openingBalance: string };
type TransferDraft = { amount: string; description: string; accountId: string; destinationAccountId: string; date: string; time: string };
const blankTransfer = (accounts: Account[]): TransferDraft => ({
  amount: "",
  description: "",
  accountId: accounts.find((account) => account.isDefault)?.id ?? accounts[0]?.id ?? "",
  destinationAccountId: accounts.find((account) => account.id !== (accounts.find((entry) => entry.isDefault)?.id ?? accounts[0]?.id))?.id ?? "",
  date: todayInManila(),
  time: timeInManila(),
});

export function AccountsView({ initial, initialTransfers, initialHasMoreTransfers }: { initial: Account[]; initialTransfers: Transaction[]; initialHasMoreTransfers: boolean }) {
  const [accounts, setAccounts] = useState(initial);
  const [transfers, setTransfers] = useState(initialTransfers);
  const [hasMoreTransfers, setHasMoreTransfers] = useState(initialHasMoreTransfers);
  const [loadingMoreTransfers, setLoadingMoreTransfers] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [draft, setDraft] = useState<AccountDraft>({ name: "", type: "cash", openingBalance: "0.00" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editingTransfer, setEditingTransfer] = useState<Transaction | null>(null);
  const [transferDraft, setTransferDraft] = useState<TransferDraft>(blankTransfer(initial));
  const [transferError, setTransferError] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [accountResult, transactionResult] = await Promise.all([
      fetch("/api/accounts").then((response) => response.json()),
      fetch("/api/transactions?kind=transfer&limit=100&offset=0").then((response) => response.json()),
    ]);
    if (accountResult.accounts) setAccounts(accountResult.accounts);
    if (transactionResult.transactions) setTransfers(transactionResult.transactions);
    setHasMoreTransfers(Boolean(transactionResult.hasMore));
  }, []);

  useEffect(() => {
    const refreshAfterAssistantTransaction = () => { void refresh().catch(() => undefined); };
    window.addEventListener(LEDGER_UPDATED_EVENT, refreshAfterAssistantTransaction);
    return () => window.removeEventListener(LEDGER_UPDATED_EVENT, refreshAfterAssistantTransaction);
  }, [refresh]);

  function create() {
    setEditing(null);
    setDraft({ name: "", type: "cash", openingBalance: "0.00" });
    setError("");
    setOpen(true);
  }

  function edit(account: Account) {
    setEditing(account);
    setDraft({ name: account.name, type: account.type, openingBalance: minorToInput(account.openingMinor) });
    setError("");
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(editing ? `/api/accounts/${editing.id}` : "/api/accounts", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save account.");
      setOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save account.");
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(account: Account) {
    const response = await fetch(`/api/accounts/${account.id}/default`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) { setError(result.error); return; }
    await refresh();
  }

  async function remove(account: Account) {
    if (!window.confirm(`Delete ${account.name}? Accounts with transaction history cannot be deleted.`)) return;
    const response = await fetch(`/api/accounts/${account.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) { setError(result.error); return; }
    await refresh();
  }

  function createTransfer() {
    setEditingTransfer(null);
    setTransferDraft(blankTransfer(accounts));
    setTransferError("");
    setTransferOpen(true);
  }

  function editTransfer(transfer: Transaction) {
    setEditingTransfer(transfer);
    setTransferDraft({
      amount: minorToInput(transfer.amountMinor),
      description: transfer.description,
      accountId: transfer.accountId,
      destinationAccountId: transfer.destinationAccountId ?? "",
      date: transfer.date,
      time: transfer.time ?? "",
    });
    setTransferError("");
    setTransferOpen(true);
  }

  async function saveTransfer(e: React.FormEvent) {
    e.preventDefault();
    setTransferBusy(true);
    setTransferError("");
    try {
      const response = await fetch(editingTransfer ? `/api/transactions/${editingTransfer.id}` : "/api/transactions", {
        method: editingTransfer ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...transferDraft, time: transferDraft.time || null, kind: "transfer" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save transfer.");
      setTransferOpen(false);
      await refresh();
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : "Could not save transfer.");
    } finally {
      setTransferBusy(false);
    }
  }

  async function removeTransfer(transfer: Transaction) {
    if (!window.confirm(`Permanently delete this ${formatPHP(transfer.amountMinor)} transfer?`)) return;
    const response = await fetch(`/api/transactions/${transfer.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) { setTransferError(result.error ?? "Could not delete transfer."); return; }
    await refresh();
  }

  async function loadMoreTransfers() {
    setLoadingMoreTransfers(true);
    setTransferError("");
    try {
      const response = await fetch(`/api/transactions?kind=transfer&limit=100&offset=${transfers.length}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load more transfers.");
      setTransfers((current) => [...current, ...(result.transactions ?? [])]);
      setHasMoreTransfers(Boolean(result.hasMore));
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : "Could not load more transfers.");
    } finally {
      setLoadingMoreTransfers(false);
    }
  }

  return <div className="page-stack">
    <section className="page-heading-row page-heading-actions-only">
      <h1 className="sr-only">Accounts</h1>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="button" disabled={accounts.length < 2} onClick={createTransfer}><ArrowLeftRight size={15}/> Transfer</button>
        <button className="button button-primary" onClick={create}><Plus size={16}/> New account</button>
      </div>
    </section>
    {accounts.length < 2 && <p className="page-note">Create two accounts to transfer money between them.</p>}
    {error && !open && <p className="error-text" role="alert">{error}</p>}
    {transferError && !transferOpen && <p className="error-text" role="alert">{transferError}</p>}
    {accounts.length ? <section className="account-grid">{accounts.map((account) => <article className="account-card" key={account.id}>
      <div className="account-card-top"><div><div className="account-type">{account.type === "cash" ? <Wallet size={14} style={{ display: "inline", marginRight: 5 }}/> : <Landmark size={14} style={{ display: "inline", marginRight: 5 }}/>}{account.type} account</div><h2 className="account-name">{account.name}</h2></div>{account.isDefault && <span className="badge badge-green">Default</span>}</div>
      <div className="account-balance">{formatPHP(account.balanceMinor)}</div>
      <div className="account-actions">{!account.isDefault && <button className="button button-small button-secondary" onClick={() => setDefault(account)}><Star size={13}/> Make default</button>}<button className="icon-button" aria-label={`Edit ${account.name}`} onClick={() => edit(account)}><Pencil size={15}/></button><button className="icon-button" aria-label={`Delete ${account.name}`} onClick={() => remove(account)}><Trash2 size={15}/></button></div>
    </article>)}</section> : <article className="panel-empty"><div style={{ display: "grid", justifyItems: "center", gap: 8 }}><Wallet size={24}/><strong>Create your first financial account</strong><span>Start with cash or a bank account.</span><button className="button button-primary" onClick={create}><Plus size={15}/> Add account</button></div></article>}

    <article className="panel"><div className="panel-heading"><div><h2>Transfers between accounts</h2><p>Move money without changing income or spending totals.</p></div>{accounts.length >= 2 && <button className="button button-small" onClick={createTransfer}><ArrowLeftRight size={14}/> New transfer</button>}</div>
      <div className="activity-list">{transfers.map((transfer) => <div className="activity-row" key={transfer.id}>
        <div className="activity-icon transfer"><ArrowLeftRight size={17}/></div>
        <div className="activity-copy"><strong>{transfer.accountName} → {transfer.destinationAccountName}</strong><span>{transfer.description || "Transfer"} · {transfer.date}{transfer.time ? ` · ${transfer.time}` : ""}</span></div>
        <strong>{formatPHP(transfer.amountMinor)}</strong>
        <button className="icon-button" aria-label="Edit transfer" onClick={() => editTransfer(transfer)}><Pencil size={15}/></button>
        <button className="icon-button" aria-label="Delete transfer" onClick={() => removeTransfer(transfer)}><Trash2 size={15}/></button>
      </div>)}{!transfers.length && <div className="panel-empty">No transfers yet. Use Transfer to move money between your accounts.</div>}</div>
      {hasMoreTransfers && <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}><button className="button button-small" onClick={loadMoreTransfers} disabled={loadingMoreTransfers}>{loadingMoreTransfers ? "Loading…" : "Load more transfers"}</button></div>}
    </article>

    <article className="panel"><div className="panel-heading"><div><h2>How account balances work</h2><p>Balances are calculated from your opening amount and owned transactions.</p></div></div><div className="activity-list">
      <div className="activity-row"><div className="activity-icon"><ArrowDownLeft size={17}/></div><div className="activity-copy"><strong>Income</strong><span>Added to the account you choose.</span></div></div>
      <div className="activity-row"><div className="activity-icon expense"><ArrowUpRight size={17}/></div><div className="activity-copy"><strong>Expense</strong><span>Subtracted from the selected account.</span></div></div>
      <div className="activity-row"><div className="activity-icon transfer"><ArrowLeftRight size={17}/></div><div className="activity-copy"><strong>Transfer</strong><span>Moves money between your accounts without changing income or spending totals.</span></div></div>
    </div></article>

    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div className="modal-heading"><div><h2 id="account-title">{editing ? "Edit account" : "New financial account"}</h2><p>Opening balance is not recorded as income.</p></div><button className="modal-close" aria-label="Close" onClick={() => setOpen(false)}><X size={16}/></button></div>
      <form onSubmit={save}><div className="form-grid"><label className="field-label span-2">Account name<input autoFocus required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Everyday cash"/></label><label className="field-label">Type<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as AccountDraft["type"] })}><option value="cash">Cash</option><option value="bank">Bank</option></select></label><label className="field-label">Opening balance<input inputMode="decimal" required value={draft.openingBalance} onChange={(e) => setDraft({ ...draft, openingBalance: e.target.value })} placeholder="0.00"/></label></div>
        {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}<div className="modal-footer"><button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button><button disabled={busy} className="button button-primary">{busy ? "Saving…" : editing ? "Save changes" : "Create account"}</button></div>
      </form>
    </section></div>}

    {transferOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setTransferOpen(false); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
      <div className="modal-heading"><div><h2 id="transfer-title">{editingTransfer ? "Edit transfer" : "Transfer between accounts"}</h2><p>Balances update together. Transfers are excluded from income and spending.</p></div><button className="modal-close" aria-label="Close" onClick={() => setTransferOpen(false)}><X size={16}/></button></div>
      <form onSubmit={saveTransfer}><div className="form-grid"><label className="field-label">Amount in PHP<input autoFocus required inputMode="decimal" value={transferDraft.amount} onChange={(e) => setTransferDraft({ ...transferDraft, amount: e.target.value })} placeholder="250.00"/></label>
        <label className="field-label">Date<input type="date" required value={transferDraft.date} onChange={(e) => setTransferDraft({ ...transferDraft, date: e.target.value })}/></label>
        <label className="field-label">Time · Asia/Manila<input type="time" required={!editingTransfer || Boolean(transferDraft.time)} value={transferDraft.time} onChange={(e) => setTransferDraft({ ...transferDraft, time: e.target.value })}/></label>
        <label className="field-label">From account<select required value={transferDraft.accountId} onChange={(e) => setTransferDraft({ ...transferDraft, accountId: e.target.value, destinationAccountId: e.target.value === transferDraft.destinationAccountId ? "" : transferDraft.destinationAccountId })}><option value="">Choose account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.isDefault ? " · default" : ""}</option>)}</select></label>
        <label className="field-label">To account<select required value={transferDraft.destinationAccountId} onChange={(e) => setTransferDraft({ ...transferDraft, destinationAccountId: e.target.value })}><option value="">Choose account</option>{accounts.filter((account) => account.id !== transferDraft.accountId).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label className="field-label span-2">Description (optional)<input maxLength={180} value={transferDraft.description} onChange={(e) => setTransferDraft({ ...transferDraft, description: e.target.value })} placeholder="Add a note"/></label>
      </div>{transferError && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{transferError}</p>}<div className="modal-footer"><button type="button" className="button" onClick={() => setTransferOpen(false)}>Cancel</button><button disabled={transferBusy} className="button button-primary">{transferBusy ? "Saving…" : editingTransfer ? "Save changes" : "Transfer"}</button></div></form>
    </section></div>}
  </div>;
}
