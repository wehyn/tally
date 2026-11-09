// Statechart view for IdentityAccess: one region per person, in the words of a user.
type V = Record<string, any>;
const person = (v: V, u: string) => {
  const s = v.status[u];
  if (s === "absent") return "No account";
  const admin = v.role[u] === "admin" ? "Admin" : "Member";
  if (s === "disabled") return `${admin}, disabled`;
  const signedIn = v.sess[u] === "none" ? "signed out" : v.sess[u] === "live" ? "signed in" : "signed in (old password)";
  const reset = v.reset[u] === "live" ? ", reset code issued" : v.reset[u] === "expired" ? ", reset code expired" : "";
  const sc = v.cred[u] === "none" ? "" : v.cred[u] === "live" ? ", Shortcut credential" : ", Shortcut credential (old password)";
  return `${admin}, ${signedIn}${sc}${reset}`;
};
export const title = "Identity and access: sign-up, sign-in, admin reset, account deletion";
export const state = (v: V) => Object.keys(v.status).length === 1 ? person(v, "u1") : ({ Alice: person(v, "u1"), Bob: person(v, "u2") });
export const step = (a: string, from: V, to: V) => {
  const names: Record<string, string> = { u1: "Alice", u2: "Bob" };
  const who = (u: string) => names[u];
  const diff = Object.keys(from.status).find((u) => from.status[u] !== to.status[u]);
  switch (a) {
    case "Register": return `${who(Object.keys(from.status).find((u) => from.status[u] === "absent" && to.status[u] !== "absent")!)} registers`;
    case "Login": return "someone signs in";
    case "Logout": return "someone signs out";
    case "UseSession": return "a signed-in browser makes a request";
    case "UseShortcut": return "a Shortcut calls the assistant";
    case "Disable": return "the admin disables a user";
    case "Enable": return "the admin re-enables a user";
    case "IssueReset": return "the admin issues a one-time reset code";
    case "Expire": return "15 minutes pass";
    case "ConsumeReset": return "the user uses the reset code to set a new password";
    case "SetCred": return "a user creates or rotates a Shortcut credential";
    case "ClearCred": return "a user revokes the Shortcut credential";
    case "DeleteAccount": return diff ? "a user deletes their account" : "a user deletes their account";
    default: return a;
  }
};
export const group = (v: V) => (Object.values(v.status).includes("disabled") ? "disabled" : Object.values(v.reset).includes("live") ? "reset" : "normal");
export const colors = { normal: "teal", reset: "orange", disabled: "tan" };
