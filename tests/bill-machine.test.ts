import { describe, expect, it } from "vitest";
import { billScheduleState, canScheduleDueDate, planPosting, type BillSchedule } from "../src/lib/machines/bill";

const weekly: BillSchedule = { nextDueDate: "2026-10-09", endDate: null, archived: false, frequency: "weekly", anchorDay: 9, anchorMonth: 10 };

describe("bill schedule machine", () => {
  it("reads a bill as archived, due, or not yet due from its stored row", () => {
    expect(billScheduleState({ nextDueDate: "2026-10-01", archived: true }, "2026-10-09")).toBe("archived");
    expect(billScheduleState({ nextDueDate: "2026-10-09", archived: false }, "2026-10-09")).toBe("due");
    expect(billScheduleState({ nextDueDate: "2026-10-10", archived: false }, "2026-10-09")).toBe("not-yet-due");
  });

  it("posts only a due, active bill, and advances it by its cadence", () => {
    expect(planPosting(weekly, "2026-10-08")).toEqual({ kind: "none" });
    expect(planPosting({ ...weekly, archived: true }, "2026-10-09")).toEqual({ kind: "none" });
    expect(planPosting(weekly, "2026-10-09")).toEqual({ kind: "post", dueDate: "2026-10-09", nextDueDate: "2026-10-16", outcome: "posted-and-advanced" });
  });

  it("archives as ended when the post reaches the end date, and archives without posting when the due date is already past it", () => {
    expect(planPosting({ ...weekly, endDate: "2026-10-15" }, "2026-10-09")).toEqual({ kind: "post", dueDate: "2026-10-09", nextDueDate: "2026-10-16", outcome: "ended" });
    expect(planPosting({ ...weekly, endDate: "2026-10-08" }, "2026-10-09")).toEqual({ kind: "end" });
  });

  it("allows any due date after the last posted date, or any date when nothing was posted", () => {
    expect(canScheduleDueDate(null, "2026-10-01")).toBe(true);
    expect(canScheduleDueDate("2026-10-09", "2026-10-09")).toBe(false);
    expect(canScheduleDueDate("2026-10-09", "2026-10-08")).toBe(false);
    expect(canScheduleDueDate("2026-10-09", "2026-10-10")).toBe(true);
  });
});
