import { getStore } from "./db";
import { todayInManila } from "./dates";

export function nextBillRunAt(now: Date): Date {
  if (!Number.isFinite(now.getTime())) throw new Error("Scheduler time must be valid.");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const boundary = (dayOffset: number) => new Date(Date.UTC(value("year"), value("month") - 1, value("day") + dayOffset, -6));
  const next = boundary(0);
  return next > now ? next : boundary(1);
}

let started = false;
export function startBillScheduler(): void {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const result = getStore().processDueBills(todayInManila());
      for (const failure of result.failures) console.error("Bill posting failed.", failure);
    }
    catch (error) { console.error("Bill schedule processing failed.", error); }
    const delay = nextBillRunAt(new Date()).getTime() - Date.now();
    setTimeout(() => { void run(); }, delay).unref();
  };
  void run();
}
