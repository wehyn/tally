const ASKED = {
  clarification: "Asked a question",
  ordinary_income: "Asked: record as ordinary income?",
  repayment_amount: "Asked: how much was repaid?",
  repayment_payer: "Asked: who paid?",
};
const WAITING = {
  plain: "complete transaction", uncertainPay: "uncertain payment", debtPay: "payer and amount", debtPayNoAmount: "payer, no amount",
  noMatchPay: "payer with no debt", amount: "a number", yes: "a yes", cancel: "your cancel",
};
export const colors = { ready: "teal", waiting: "blue", asking: "yellow", saved: "purple", error: "pink" };
export const state = (v) => {
  if (v.phase === "saved" && v.intent === "cancel" && v.pendAtStart !== "none") return "Dropping the question";
  if (v.phase === "saved") return `Waiting for the model: ${WAITING[v.intent]}`;
  if (v.phase === "errored") return "Error shown";
  if (v.conv === "gone") return "Chat deleted";
  if (v.pend !== "none") return ASKED[v.pend];
  if (v.last === "wrote") return { open: "Saved, Undo open", expired: "Saved, Undo expired", used: "Saved, then undone", none: "Saved, no Undo (repayment)" }[v.undo];
  return "Ready";
};
export const group = (v) => {
  const s = state(v);
  if (s === "Ready") return "ready";
  if (s.startsWith("Waiting") || s === "Dropping the question") return "waiting";
  if (s.startsWith("Asked")) return "asking";
  if (s === "Error shown" || s === "Chat deleted") return "error";
  return "saved";
};
const INTENT = {
  plain: "you send a complete transaction",
  uncertainPay: "you send an uncertain payment",
  debtPay: "you say who paid and how much",
  debtPayNoAmount: "you say who paid, no amount",
  noMatchPay: "you report a payment from someone with no open debt",
  amount: "you send just a number",
  yes: "you send a bare yes",
  cancel: "you say cancel",
};
export const step = (action, from, to) => {
  if (action === "YouSend") return INTENT[to.intent];
  if (action === "YouResend") return "you send it again";
  if (action === "ProviderOk") {
    if (from.intent === "cancel" && from.pendAtStart !== "none") return "Tally drops the question, saving nothing";
    return to.ledger > from.ledger ? "the model answers and Tally saves it" : "the model answers and Tally asks, saving nothing";
  }
  if (action === "ProviderFail") return "the model call fails";
  if (action === "ClockExpires") return "ten seconds pass";
  if (action === "YouUndo") return "you press Undo";
  if (action === "GiveUp") return "you give up";
  return null;
};
