// Flow chart: one person's sign-up, sign-in and admin-issued password reset.
type V = Record<string, Record<string, string>>;
export const title = "One person: sign up, sign in, admin password reset";
export const state = (v: V) => {
  if (v.status.u1 === "absent") return "No account";
  const s = v.sess.u1 === "none" ? "Signed out" : v.sess.u1 === "live" ? "Signed in" : "Old browser session refused";
  return v.reset.u1 === "live" ? `${s}, reset code waiting` : s;
};
export const group = (v: V) => (v.reset.u1 === "live" ? "reset" : v.status.u1 === "absent" ? "none" : "normal");
export const colors = { normal: "teal", reset: "orange", none: "tan" };
const hidden = new Set(["UseSession", "UseShortcut", "SetCred", "ClearCred", "DeleteAccount"]);
export const step = (a: string) => {
  if (hidden.has(a)) return null;
  return ({
    Register: "you register (the first user is the admin)",
    Login: "you sign in",
    Logout: "you sign out",
    IssueReset: "the admin issues a one-time reset code",
    Expire: "15 minutes pass",
    ConsumeReset: "you use the code to choose a new password",
  } as Record<string, string>)[a] ?? a;
};
