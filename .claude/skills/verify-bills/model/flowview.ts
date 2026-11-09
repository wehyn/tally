export const title = "Bill from creation to the last payment";
export const state = (v: any) => {
  const run = v.run === "none" ? "" : ", run in progress";
  if (!v.started) return "Bill saved, app not started";
  if (v.archived) return `Archived${run}`;
  if (v.next <= v.today) return `Due${v.acctOK ? "" : ", account invalid"}${run}`;
  return `Waiting for due date${run}`;
};
export const group = (v: any) => (v.archived ? "tan" : v.next <= v.today ? "orange" : "teal");
export const colors = { tan: "tan", orange: "orange", teal: "teal" };
export const step = (a: string) => ({
  Start: "app starts and runs the scheduler", Tick: "Manila midnight", StepGone: "nothing left to post",
  StepEnded: "the end date has passed", StepFail: "posting fails, bill stays due", StepPost: "expense is posted",
  AccountBreaks: "the account or amount becomes invalid, or valid again",
} as Record<string, string>)[a] ?? a;
