// Flow chart: two people, admin role, disabling, and deleting an account.
type V = Record<string, Record<string, string>>;
const who = (v: V, u: string) => (v.status[u] === "absent" ? "no account" : `${v.role[u] === "admin" ? "admin" : "member"}${v.status[u] === "disabled" ? " (disabled)" : ""}`);
export const title = "Two people: first admin, disable and re-enable, delete with admin handoff";
export const state = (v: V) => `Alice ${who(v, "u1")}, Bob ${who(v, "u2")}`;
export const group = (v: V) => (Object.values(v.status).includes("disabled") ? "disabled" : Object.values(v.status).every((s) => s === "absent") ? "none" : "normal");
export const colors = { normal: "teal", disabled: "tan", none: "blue" };
export const step = (a: string, from: V, to: V) => {
  const name = (u: string) => (u === "u1" ? "Alice" : "Bob");
  const changed = Object.keys(from.status).find((u) => from.status[u] !== to.status[u])!;
  const admin = Object.keys(from.role).find((u) => from.role[u] === "admin");
  switch (a) {
    case "Register": return `${name(changed)} registers`;
    case "Disable": return `the admin disables ${name(changed)}`;
    case "Enable": return `the admin re-enables ${name(changed)}`;
    case "DeleteAccount": return admin === changed && Object.keys(to.role).some((u) => to.role[u] === "admin") ? `${name(changed)} deletes their account and hands admin to the other` : `${name(changed)} deletes their account`;
    default: return a;
  }
};
