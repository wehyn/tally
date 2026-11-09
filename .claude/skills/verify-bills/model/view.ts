export const title = "Bill schedule";
export const state = (v: any) => {
  const phase = v.archived ? "Archived" : v.next <= v.today ? "Due" : "Waiting";
  const run = v.run === "none" ? "" : " - posting";
  return `${phase}${run}`;
};
export const group = (v: any) => (v.archived ? "tan" : v.next <= v.today ? "orange" : "teal");
export const colors = { tan: "tan", orange: "orange", teal: "teal" };
export const step = (a: string) => ({
  Start: "app starts", Tick: "Manila midnight", ApiRun: "you save an edit", StepGone: "nothing left to post",
  StepEnded: "the end date has passed", StepFail: "posting fails", StepPost: "expense is posted", Crash: "the run crashes",
  Edit: "you edit the bill", Archive: "you archive the bill", AccountBreaks: "the account or amount becomes invalid",
} as Record<string, string>)[a] ?? a;
