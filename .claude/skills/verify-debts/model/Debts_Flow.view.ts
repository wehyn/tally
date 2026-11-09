// Reader's words for the debt flow chart. Used with Debts_FlowOwed.cfg and Debts_FlowOwe.cfg.
export const title = "A debt from first record to deletion";

const matches = (v: any) => v.amount === v.principal + v.deltaSum;

export const state = (v: any) => {
  if (v.deleted) return "Deleted (transactions stay, unlinked)";
  if (v.status === "open") {
    if (!matches(v)) return "Reopened (screen and history disagree)";
    return v.paid > 0 ? "Open, partly repaid" : "Open";
  }
  return "Settled";
};

export const group = (v: any) => (v.deleted ? "tan" : v.status === "open" ? (matches(v) ? "blue" : "orange") : "teal");

export const step = (action: string, from: any, to: any) => {
  if (action === "Pay") return to.status === "settled" ? "last payment is recorded" : "a partial payment is recorded";
  if (action === "Settle") return "you press Settle";
  if (action === "Reopen") return "you press Reopen";
  if (action === "Delete") return "you delete the debt";
  return null;
};

export const colors = { blue: "blue", orange: "orange", teal: "teal", tan: "tan" };
