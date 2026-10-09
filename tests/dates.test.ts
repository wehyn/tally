import { describe, expect, it } from "vitest";
import { isUndoAvailable, monthToDateRange, todayInManila, trailingDaysRange } from "../src/lib/dates";

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
