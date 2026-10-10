import { describe, expect, it } from "vitest";
import { advanceBillDate, isUndoAvailable, monthToDateRange, todayInManila, trailingDaysRange } from "../src/lib/dates";

describe("Asia/Manila calendar ranges", () => {
  it("uses Manila's local calendar day rather than UTC", () => {
    expect(todayInManila(new Date("2026-01-30T16:30:00.000Z"))).toBe("2026-01-31");
  });

  it("makes month-to-date boundaries inclusive and local", () => {
    expect(monthToDateRange(new Date("2026-03-31T16:30:00.000Z"))).toEqual({ start: "2026-04-01", end: "2026-04-01" });
  });

  it("returns the requested number of inclusive local days", () => {
    expect(trailingDaysRange(7, new Date("2026-02-01T00:00:00.000Z"))).toEqual({ start: "2026-01-26", end: "2026-02-01" });
  });

  it("keeps undo available through its deadline but not after it", () => {
    const deadline = "2026-10-09T04:00:10.000Z";
    expect(isUndoAvailable(deadline, Date.parse("2026-10-09T04:00:10.000Z"))).toBe(true);
    expect(isUndoAvailable(deadline, Date.parse("2026-10-09T04:00:10.001Z"))).toBe(false);
    expect(isUndoAvailable(deadline, 0)).toBe(false);
    expect(isUndoAvailable("not-a-date", Date.parse("2026-10-09T04:00:00.000Z"))).toBe(false);
  });
});

describe("anchored bill recurrence", () => {
  it("advances weekly schedules by seven days", () => {
    expect(advanceBillDate("2026-10-09", "weekly", 9, 10)).toBe("2026-10-16");
  });

  it("returns to the original month-end day after a short month", () => {
    expect(advanceBillDate("2026-01-31", "monthly", 31, 1)).toBe("2026-02-28");
    expect(advanceBillDate("2026-02-28", "monthly", 31, 1)).toBe("2026-03-31");
  });

  it("returns to leap day after non-leap years", () => {
    expect(advanceBillDate("2024-02-29", "yearly", 29, 2)).toBe("2025-02-28");
    expect(advanceBillDate("2025-02-28", "yearly", 29, 2)).toBe("2026-02-28");
    expect(advanceBillDate("2027-02-28", "yearly", 29, 2)).toBe("2028-02-29");
  });
});
