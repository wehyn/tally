// Replays the TLA+ model (../model/Ledger.tla) against the real store in src/lib/store.ts.
// A reference model written from the TLA+ guards predicts whether each action is accepted and what each
// balance must be; after every step the real database is checked against the model's invariants.
// Seeded random walks, so a failure reproduces: the failing seed and action list are printed.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createStore } from "../../../../src/lib/store";

type Kind = "income" | "expense" | "transfer" | "debt_repayment";
type RefTxn = { id: string; kind: Kind; from: number; to: number | null; cat: "income" | "expense" | null; amt: number; src: "manual" | "assistant"; linked: boolean };

function rng(seed: number) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}
const DATE = "2026-01-15";

function runWalk(seed: number, steps: number) {
  const db = new Database(":memory:");
  const store = createStore(db);
  store.migrate();
  const me = store.registerUser("walker", "hash").id;
  const other = store.registerUser("stranger", "hash").id;
  const foreign = store.createAccount(other, { name: "Theirs", type: "cash", openingMinor: 0 }).id;
  const cats = store.listCategories(me);
  const incomeCat = cats.find((c) => c.type === "income")!.id;
  const expenseCat = cats.find((c) => c.type === "expense")!.id;
  const rand = rng(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];

  // reference state (mirrors the TLA+ variables)
  const slots: (string | null)[] = [null, null, null];     // model account slot -> id
  const base: number[] = [0, 0, 0];
  let defaultSlot: number | null = null;
  const txns: RefTxn[] = [];
  const log: string[] = [];
  const ids = () => slots.filter((x): x is string => x !== null);
  const slotOf = (id: string) => slots.indexOf(id);
  const flow = (s: number) => txns.reduce((sum, t) => sum
    + ((t.kind === "income" || t.kind === "debt_repayment") && t.from === s ? t.amt : 0)
    + (t.kind === "expense" && t.from === s ? -t.amt : 0)
    + (t.kind === "transfer" && t.from === s ? -t.amt : 0)
    + (t.kind === "transfer" && t.to === s ? t.amt : 0), 0);
  const bal = (s: number) => base[s] + flow(s);
  const used = (s: number) => txns.some((t) => t.from === s || t.to === s);
  const acct = (s: number) => slots[s]!;
  const attempt = (label: string, expectOk: boolean, fn: () => void) => {
    log.push(`${label} expect ${expectOk ? "accept" : "reject"}`);
    let ok = true;
    try { fn(); } catch { ok = false; }
    expect(ok, `seed ${seed}: ${log.join(" > ")}`).toBe(expectOk);
    return ok;
  };

  function check() {
    const accounts = store.listAccounts(me);
    const where = `seed ${seed}: ${log.join(" > ")}`;
    // OneDefault
    const defaults = accounts.filter((a) => a.isDefault);
    const stored = (db.prepare("SELECT default_account_id AS d FROM users WHERE id=?").get(me) as { d: string | null }).d;
    if (accounts.length === 0) expect(stored, `OneDefault ${where}`).toBeNull();
    else { expect(defaults.length, `OneDefault ${where}`).toBe(1); expect(stored, `OneDefault mirror ${where}`).toBe(defaults[0].id); }
    // KeepOneAccount + same accounts as the reference
    expect(accounts.map((a) => a.id).sort(), `accounts ${where}`).toEqual(ids().sort());
    // balances = base + flows (covers TransfersNeutral and delete/edit/undo restoring balances exactly)
    for (const a of accounts) expect(a.balanceMinor, `balance ${where}`).toBe(bal(slotOf(a.id)));
    const total = accounts.reduce((sum, a) => sum + a.balanceMinor, 0);
    const expected = ids().reduce((sum, _id, i) => sum + base[slotOf(ids()[i])], 0)
      + txns.reduce((sum, t) => sum + (t.kind === "income" || t.kind === "debt_repayment" ? t.amt : t.kind === "expense" ? -t.amt : 0), 0);
    expect(total, `TransfersNeutral ${where}`).toBe(expected);
    // TxnRefsValid + NoOrphan
    const rows = store.listTransactions(me, undefined, 501);
    expect(rows.length, `txn count ${where}`).toBe(txns.length);
    const catType = new Map(store.listCategories(me).map((c) => [c.id, c.type]));
    for (const r of rows) {
      expect(slotOf(r.accountId), `TxnRefsValid source ${where}`).toBeGreaterThanOrEqual(0);
      if (r.kind === "transfer") {
        expect(slotOf(r.destinationAccountId ?? ""), `TxnRefsValid destination ${where}`).toBeGreaterThanOrEqual(0);
        expect(r.destinationAccountId, where).not.toBe(r.accountId);
        expect(r.categoryId, where).toBeUndefined();
      } else if (r.kind === "debt_repayment") {
        expect(r.categoryId ?? r.destinationAccountId, where).toBeUndefined();
      } else {
        expect(catType.get(r.categoryId ?? ""), `TxnRefsValid category type ${where}`).toBe(r.kind === "income" ? "income" : "expense");
        expect(r.destinationAccountId, where).toBeUndefined();
      }
      if (r.undoUntil) { expect(r.source, `UndoShape ${where}`).toBe("assistant"); expect(r.debtId, `UndoShape ${where}`).toBeUndefined(); }
    }
  }

  const actions: (() => void)[] = [
    // CreateAccount
    () => { const s = pick([0, 1, 2]); const open = pick([0, 1, 2]); if (slots[s] !== null) return; attempt(`createAccount(${s},${open})`, true, () => {
      const a = store.createAccount(me, { name: `A${s}`, type: "cash", openingMinor: open }); slots[s] = a.id; base[s] = open; if (defaultSlot === null) defaultSlot = s; }); },
    // SetDefault
    () => { const s = pick([0, 1, 2]); if (slots[s] === null) return; attempt(`setDefault(${s})`, true, () => { store.setDefaultAccount(me, acct(s)); defaultSlot = s; }); },
    () => { attempt(`setDefault(foreign)`, false, () => store.setDefaultAccount(me, foreign)); },
    // SetBalance
    () => { const s = pick([0, 1, 2]); if (slots[s] === null) return; const v = pick([0, 1, 2, 3]); attempt(`setBalance(${s},${v})`, true, () => { store.updateAccount(me, acct(s), { balanceMinor: v }); base[s] = v - flow(s); }); },
    // DeleteAccount (the bill guard is another subsystem and is not replayed here)
    () => { const s = pick([0, 1, 2]); if (slots[s] === null) return; const ok = ids().length > 1 && !used(s);
      attempt(`deleteAccount(${s})`, ok, () => { store.deleteAccount(me, acct(s)); slots[s] = null; base[s] = 0;
        if (defaultSlot === s) defaultSlot = slots.findIndex((x) => x !== null); }); },
    // CreateTxn: valid and invalid shapes
    () => { const f = pick([0, 1, 2]); const t = pick([0, 1, 2]); const kind = pick(["income", "expense", "transfer"] as const); const src = pick(["manual", "assistant"] as const);
      const wrongCat = rand() < 0.25 && kind !== "transfer"; const toForeign = rand() < 0.15; const fromForeign = rand() < 0.1;
      const cat = kind === "transfer" ? undefined : (kind === "income") !== wrongCat ? incomeCat : expenseCat;
      const fromId = fromForeign ? foreign : slots[f]; const toId = toForeign ? foreign : slots[t];
      const valid = !fromForeign && slots[f] !== null && (kind !== "transfer" || (!toForeign && slots[t] !== null && t !== f)) && !wrongCat;
      attempt(`createTxn(${kind},${fromForeign ? "foreign" : f},${kind === "transfer" ? (toForeign ? "foreign" : t) : "-"},${wrongCat ? "wrongCat" : "cat"},${src})`, valid, () => {
        const tx = store.createTransaction(me, { kind, amountMinor: 1, accountId: fromId ?? "missing", destinationAccountId: kind === "transfer" ? toId ?? "missing" : undefined, categoryId: cat, description: "", date: DATE, source: src });
        txns.push({ id: tx.id, kind, from: f, to: kind === "transfer" ? t : null, cat: kind === "transfer" ? null : kind, amt: 1, src, linked: false }); }); },
    // CreateRepayment (debt-linked, via recordDebtPayment)
    () => { const f = pick([0, 1, 2]); if (slots[f] === null) return; attempt(`recordDebtPayment(${f})`, true, () => {
      const debt = store.createDebt(me, { direction: "owed_to_you", counterparty: `P${txns.length}`, amountMinor: 1 });
      const out = store.recordDebtPayment(me, debt.id, { amountMinor: 1, accountId: acct(f), description: "", date: DATE });
      txns.push({ id: out.transaction.id, kind: "debt_repayment", from: f, to: null, cat: null, amt: 1, src: "assistant", linked: true }); }); },
    // EditTxn
    () => { if (!txns.length) return; const t = pick(txns); const kind = pick(["income", "expense", "transfer", "debt_repayment"] as const);
      const f = pick([0, 1, 2]); const to = pick([0, 1, 2]); const amt = pick([1, 2]); const wrongCat = rand() < 0.2 && (kind === "income" || kind === "expense");
      const cat = kind === "transfer" || kind === "debt_repayment" ? undefined : (kind === "income") !== wrongCat ? incomeCat : expenseCat;
      const valid = slots[f] !== null && !wrongCat && (kind !== "transfer" || (slots[to] !== null && to !== f))
        && (kind !== "debt_repayment" || t.kind === "debt_repayment") && (!t.linked || (kind === t.kind && amt === t.amt));
      attempt(`editTxn(${t.kind}->${kind},${f},${to},amt ${amt},${wrongCat ? "wrongCat" : "cat"},linked ${t.linked})`, valid, () => {
        store.updateTransaction(me, t.id, { kind, amountMinor: amt, accountId: acct(f), destinationAccountId: kind === "transfer" ? acct(to) : undefined, categoryId: cat, description: "", date: DATE });
        Object.assign(t, { kind, from: f, to: kind === "transfer" ? to : null, cat: kind === "income" || kind === "expense" ? kind : null, amt }); }); },
    // DeleteTxn and assistant Undo
    () => { if (!txns.length) return; const t = pick(txns); const undo = rand() < 0.5;
      const ok = !t.linked && (!undo || t.src === "assistant");
      attempt(`deleteTxn(${t.kind},${t.src},undo ${undo},linked ${t.linked})`, ok, () => { store.deleteTransaction(me, t.id, undo); txns.splice(txns.indexOf(t), 1); }); },
  ];

  check();
  for (let i = 0; i < steps; i += 1) { pick(actions)(); check(); }
  db.close();
}

describe("ledger model replayed on the real store", () => {
  it("accepts and rejects exactly what the model allows and keeps every model invariant", () => {
    for (let seed = 1; seed <= 300; seed += 1) runWalk(seed, 25);
  }, 120_000);
});
