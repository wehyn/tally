// EditTxn and ExpireUndo never change what this chart shows, so they are hidden.
// Reader-facing view for the small-bound chart config (Ledger.chart.cfg).
export const title = "Tally ledger: accounts, default account and one transaction";
const names = { a1: "Cash", a2: "Bank" };
const nm = (a) => names[a] ?? a;

export const state = (v) => {
  const accts = [...v.acct].sort();
  const where = accts.length === 0 ? "No accounts" : accts.length === 1 ? `${nm(accts[0])} only (default)` : `Cash and Bank, default ${nm(v.userDef)}`;
  const t = v.txn[1];
  const txn = t.kind === "none" ? "no transaction" : "transaction logged";
  return `${where} / ${txn}`;
};
export const group = (v) => (v.acct.length === 0 ? "tan" : v.txn[1].kind === "none" ? "blue" : "teal");
export const colors = { tan: "tan", blue: "blue", teal: "teal" };
export const step = (action, from, to) => {
  switch (action) {
    case "CreateAccount": return from.acct.length === 0 ? "you add your first account (it becomes the default)" : "you add another account";
    case "SetDefault": return "you pick the default account";
    case "DeleteAccount": return "you delete an unused account (default moves if needed)";
    case "CreateTxn": return "you log income, spending or a transfer";
    case "CreateRepayment": return "a debt payment is recorded";
    case "DeleteTxn": return "you delete (or Undo) the transaction";
    default: return null;
  }
};
