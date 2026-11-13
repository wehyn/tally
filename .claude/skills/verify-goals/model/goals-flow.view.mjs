// View for the two-person goal flow chart (goals-flow.cfg). Person 1 creates the goal; person 2 is invited.
const word = { none: "not invited", invited: "invited", accepted: "member", left: "left", removed: "removed", former: "account deleted" };
export const title = "Shared goal: invite, contribute, complete, hand over";
export const state = (v) => {
  if (v.gstatus === "archived") return "Archived, no manager";
  const goal = v.gstatus === "completed" ? "Completed" : "Active";
  if (v.manager !== 1) return `${goal}, invitee took over`;
  return `${goal}, invitee ${word[v.mstat[2]]}`;
};
export const group = (v) => (v.gstatus === "archived" ? "tan" : v.gstatus === "completed" ? "teal" : "blue");
export const colors = { tan: "tan", teal: "teal", blue: "blue" };
export const step = (action, from, to) => {
  switch (action) {
    case "Invite": return "the manager invites the other person";
    case "Respond": return to.mstat[2] === "accepted" ? "invitee accepts" : "invitee declines";
    case "Change": {
      if (to.mstat[2] !== from.mstat[2]) return to.mstat[2] === "left" ? "invitee leaves" : "you remove the invitee";
      if (to.gstatus === "archived") return "you leave and nobody can take over";
      return "you leave and the invitee takes over";
    }
    case "AddContribution": return to.gstatus === "completed" ? "someone contributes enough to meet the target" : "someone contributes";
    case "RaiseOrLowerTarget": return to.target > from.target ? "the manager raises the target" : "the manager lowers the target";
    default: return null;
  }
};
