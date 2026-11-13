// Replays the Bills.tla rules against the real store: every sequence of up to DEPTH actions on one weekly bill.
// One model "day" is one week (weekly bills advance by 7 days). Day 0 is 2026-10-09 (Asia/Manila).
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../../../src/lib/store";

const DEPTH = Number(process.env.VERIFY_BILLS_DEPTH ?? 3);
const DAY0 = Date.UTC(2026, 9, 9);
const dateOf = (day: number) => new Date(DAY0 + day * 7 * 86400_000).toISOString().slice(0, 10);
const dayOf = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - DAY0) / (7 * 86400_000));
const setToday = (day: number) => vi.setSystemTime(new Date(DAY0 + day * 7 * 86400_000 + 8 * 3600_000)); // 16:00 Manila

type Act = { name: string; day?: number; offset?: number };
const ACTIONS: Act[] = [{ name: "tick" }, { name: "run" }, { name: "archive" }, { name: "end", day: 1 }, { name: "end", day: -1 }, { name: "break" }, { name: "fix" }, { name: "date", offset: 0 }, { name: "date", offset: 1 }];

function fresh(nextDay: number, endDay: number | null) {
  const db = new Database(":memory:");
  const store = createStore(db); store.migrate();
  const user = store.registerUser("verify_bills", "hash");
  const accountId = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 100000 }).id;
  const categoryId = store.listCategories(user.id).find((c) => c.name === "Utilities")!.id;
  const bill = store.createBill(user.id, { name: "Water", amountMinor: 500, frequency: "weekly", nextDueDate: dateOf(nextDay), endDate: endDay === null ? null : dateOf(endDay), accountId, categoryId });
  const incomeCategoryId = store.listCategories(user.id).find((c) => c.type === "income")!.id;
  return { db, store, user, bill, first: nextDay, categoryId, incomeCategoryId };
}
const posted = (db: Database.Database) => (db.prepare("SELECT date FROM transactions WHERE description='Water' ORDER BY date").all() as { date: string }[]).map((r) => r.date);

function replay(nextDay: number, endDay: number | null, seq: Act[]) {
  const { db, store, user, bill, first, categoryId, incomeCategoryId } = fresh(nextDay, endDay);
  let today = 0; let broken = false; let ever = false; let dateEdited = false;
  const trace: string[] = [];
  try {
    for (const act of seq) {
      trace.push(act.name + (act.day !== undefined ? `(${act.day})` : ""));
      const before = store.listBills(user.id)[0]; const postedBefore = posted(db);
      let ran = false; let failures = 0; let accepted = false;
      const fail = (rule: string) => `${rule} after [${trace.join(", ")}] from next=${nextDay} end=${endDay}`;
      if (act.name === "tick") { today++; setToday(today); ran = true; }
      if (act.name === "run") ran = true;
      if (act.name === "archive") store.archiveBill(user.id, bill.id);
      if (act.name === "end" && broken) expect(() => store.updateBill(user.id, bill.id, { endDate: dateOf(today) }, before.nextDueDate)).toThrow(); // a bill with an invalid category cannot be edited
      else if (act.name === "end") store.updateBill(user.id, bill.id, { endDate: dateOf(Math.max(act.day! < 0 ? 0 : act.day! + today, 0)) }, before.nextDueDate);
      if (act.name === "date") {
        // Edit.cfg: the form may set nextDueDate to any date today or later, but not to a date already posted.
        const target = dateOf(today + act.offset!);
        const lastPosted = postedBefore[postedBefore.length - 1];
        const allowed = !broken && (target === before.nextDueDate || (target >= dateOf(today) && (lastPosted === undefined || target > lastPosted)));
        if (broken) expect(() => store.updateBill(user.id, bill.id, { nextDueDate: target }, before.nextDueDate), fail("date edit of a broken bill")).toThrow();
        else if (allowed) { store.updateBill(user.id, bill.id, { nextDueDate: target }, before.nextDueDate); accepted = true; dateEdited = true; }
        else expect(() => store.updateBill(user.id, bill.id, { nextDueDate: target }, before.nextDueDate), fail("date edit refused")).toThrow(/already posted|today or later/);
      }
      if (act.name === "break") { db.prepare("UPDATE bills SET category_id=? WHERE id=?").run(incomeCategoryId, bill.id); broken = true; }
      if (act.name === "fix") { db.prepare("UPDATE bills SET category_id=? WHERE id=?").run(categoryId, bill.id); broken = false; }
      if (ran) { ever = true; failures = store.processDueBills(dateOf(today)).failures.length; }
      const after = store.listBills(user.id)[0]; const postedAfter = posted(db);
      // NoDoublePost: no date is expensed twice, whatever the edits.
      expect(new Set(postedAfter).size, fail("NoDoublePost")).toBe(postedAfter.length);
      // ExactlyOnce: until a date edit skips dates, one expense for each date from the first due date up to (not including) nextDueDate.
      const expected: string[] = []; for (let d = first; d < dayOf(after.nextDueDate); d++) expected.push(dateOf(d));
      if (!dateEdited) expect(postedAfter, fail("ExactlyOnce")).toEqual(expected);
      // NoPostWhenInactive: a run on an archived bill posts nothing; nothing is posted past today or past the end date.
      if (ran && before.archivedAt) expect(postedAfter, fail("NoPostWhenInactive(archived)")).toEqual(postedBefore);
      for (const d of postedAfter.filter((x) => !postedBefore.includes(x))) {
        expect(d <= dateOf(today), fail("NoPostWhenInactive(future)")).toBe(true);
        if (after.endDate) expect(d <= after.endDate, fail("NoPostWhenInactive(past end)")).toBe(true);
      }
      // NoSilentRegression: nextDueDate only moves backwards through an accepted user edit of the date.
      expect(after.nextDueDate >= before.nextDueDate || accepted, fail("NoSilentRegression")).toBe(true);
      // NoLostDue: after a clean run an active bill has nothing due; a failed run reports the failure and keeps the due date.
      if (ran && !before.archivedAt && !broken) { if (!after.archivedAt) expect(after.nextDueDate > dateOf(today), fail("NoLostDue")).toBe(true); }
      if (ran && broken && !after.archivedAt && after.nextDueDate <= dateOf(today)) expect(failures, fail("NoLostDue(failure not reported)")).toBeGreaterThan(0);
    }
  } finally { db.close(); }
  void ever;
}

afterEach(() => { vi.useRealTimers(); });

describe("bills: real store matches Bills.tla", () => {
  it(`holds for every action sequence up to depth ${DEPTH}`, () => {
    vi.useFakeTimers(); setToday(0);
    let n = 0;
    const walk = (nextDay: number, endDay: number | null, seq: Act[]) => {
      if (seq.length) { setToday(0); replay(nextDay, endDay, seq); n++; }
      if (seq.length < DEPTH) for (const a of ACTIONS) walk(nextDay, endDay, [...seq, a]);
    };
    for (const [nextDay, endDay] of [[0, null], [1, 2], [0, 1]] as [number, number | null][]) walk(nextDay, endDay, []);
    expect(n).toBeGreaterThan(1000);
  });

  // Edit.cfg: editing nextDueDate back to a posted date is refused, so the expense is not posted again.
  it("rejects editing nextDueDate back to a posted date, and the date is not posted twice", () => {
    vi.useFakeTimers(); setToday(0);
    const { db, store, user, bill } = fresh(0, null);
    store.processDueBills(dateOf(0));
    expect(posted(db)).toEqual([dateOf(0)]);
    expect(() => store.updateBill(user.id, bill.id, { nextDueDate: dateOf(0) }, store.listBills(user.id)[0].nextDueDate)).toThrow(/already posted/);
    expect(store.processDueBills(dateOf(0))).toEqual({ processed: 0, failures: [] });
    expect(posted(db)).toEqual([dateOf(0)]);
    db.close();
  });
});
