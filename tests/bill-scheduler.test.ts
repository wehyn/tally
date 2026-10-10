import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nextBillRunAt, startBillScheduler } from "../src/lib/bill-scheduler";
import { BillsView } from "../src/components/bills-view";

const mocks = vi.hoisted(() => ({ processDueBills: vi.fn() }));
vi.mock("../src/lib/db", () => ({ getStore: () => ({ processDueBills: mocks.processDueBills }) }));

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("Manila bill scheduler", () => {
  it("selects the next strict 02:00 Manila boundary across UTC dates", () => {
    expect(nextBillRunAt(new Date("2026-10-09T17:59:00.000Z")).toISOString()).toBe("2026-10-09T18:00:00.000Z");
    expect(nextBillRunAt(new Date("2026-10-09T18:00:00.000Z")).toISOString()).toBe("2026-10-10T18:00:00.000Z");
    expect(nextBillRunAt(new Date("2026-10-09T15:00:00.000Z")).toISOString()).toBe("2026-10-09T18:00:00.000Z");
  });

  it("runs once at startup, guards duplicate starts, and schedules again after failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T08:00:00.000Z"));
    mocks.processDueBills.mockImplementationOnce(() => { throw new Error("temporary database issue"); });
    mocks.processDueBills.mockReturnValueOnce({ processed: 0, failures: [{ billId: "bill-123", dueDate: "2026-10-08", message: "balance overflow" }] });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startBillScheduler();
    startBillScheduler();
    await vi.waitFor(() => expect(mocks.processDueBills).toHaveBeenCalledTimes(1));
    expect(mocks.processDueBills).toHaveBeenCalledWith("2026-10-09");
    expect(log).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 60 * 1000);

    expect(mocks.processDueBills.mock.calls).toEqual([["2026-10-09"], ["2026-10-10"]]);
    expect(log).toHaveBeenCalledWith("Bill posting failed.", { billId: "bill-123", dueDate: "2026-10-08", message: "balance overflow" });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("shows posting pending for an active bill whose due date has passed", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T08:00:00.000Z"));
    const html = renderToStaticMarkup(createElement(BillsView, {
      initialBills: [{ id: "bill-123", name: "Power", amountMinor: 100, frequency: "monthly", nextDueDate: "2026-10-08", anchorDay: 8, anchorMonth: 10, accountId: "account-1", categoryId: "category-1", accountName: "Wallet", categoryName: "Utilities", archivedAt: null, icon: "calendar" }],
      accounts: [], categories: [],
    }));
    expect(html).toContain("Posting pending · due Oct 8, 2026");
  });
});
