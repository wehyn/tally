// Reader's words for the debt flow chart. Used with Debts_FlowOwed.cfg and Debts_FlowOwe.cfg.
export const title = "A debt from first record to deletion";

type Vars = { amount: number; principal: number; deltaSum: number; deleted: boolean; status: string; paid: number };

const matches = (v: Vars) => v.amount === v.principal + v.deltaSum;

export const state = (v: Vars) => {
  if (v.deleted) return "Deleted (transactions stay, unlinked)";
  if (v.status === "open") {
    if (!matches(v)) return "Reopened (screen and history disagree)";
    return v.paid > 0 ? "Open, partly repaid" : "Open";
  }
  return "Settled";
};

export const group = (v: Vars) => (v.deleted ? "tan" : v.status === "open" ? (matches(v) ? "blue" : "orange") : "teal");

export const step = (action: string, _from: Vars, to: Vars) => {
  if (action === "Pay") return to.status === "settled" ? "last payment is recorded" : "a partial payment is recorded";
  if (action === "Settle") return "you press Settle";
  if (action === "Reopen") return "you press Reopen";
  if (action === "Delete") return "you delete the debt";
  return null;
};

export const colors = { blue: "blue", orange: "orange", teal: "teal", tan: "tan" };
