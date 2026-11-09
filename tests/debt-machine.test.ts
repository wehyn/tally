import { describe, expect, it } from "vitest";
import { acceptsAdvance, acceptsPayment, canChangeDirection, debtAfterPayment, historyAdjustmentForUpdate, nextDebtStatus } from "../src/lib/machines/debt";

describe("debt payment rule", () => {
  it("stays open with the remaining balance after a partial payment", () => {
    expect(debtAfterPayment(1000, 400)).toEqual({ amountMinor: 600, status: "open" });
  });
  it("settles on full payment and keeps the last outstanding balance", () => {
    expect(debtAfterPayment(1000, 1000)).toEqual({ amountMinor: 1000, status: "settled" });
  });
});

describe("debt guards", () => {
  it("accepts a payment only on an open debt in the expected direction", () => {
    expect(acceptsPayment({ status: "open", direction: "owed_to_you" }, "owed_to_you")).toBe(true);
    expect(acceptsPayment({ status: "open", direction: "you_owe" }, "owed_to_you")).toBe(false);
    expect(acceptsPayment({ status: "settled", direction: "you_owe" }, "you_owe")).toBe(false);
  });
  it("accepts an advance only while the debt is open", () => {
    expect(acceptsAdvance("open")).toBe(true);
    expect(acceptsAdvance("settled")).toBe(false);
  });
  it("locks the direction once any transaction links to the debt", () => {
    expect(canChangeDirection(false)).toBe(true);
    expect(canChangeDirection(true)).toBe(false);
  });
  it("keeps the amount on settle and reopen, and treats a repeated status as a no-op", () => {
    expect(nextDebtStatus("open", "settled")).toBe("settled");
    expect(nextDebtStatus("settled", "open")).toBe("open");
    expect(nextDebtStatus("settled", undefined)).toBe("settled");
    expect(nextDebtStatus("settled", "settled")).toBe("settled");
  });
});

describe("debt history adjustment", () => {
  const open = (amountMinor: number) => ({ status: "open" as const, amountMinor });
  const settled = (amountMinor: number) => ({ status: "settled" as const, amountMinor });
  it("moves an open debt's history to its edited amount", () => {
    expect(historyAdjustmentForUpdate(open(1000), open(1400), 1000)).toEqual({ deltaMinor: 400, reason: "manual amount edit" });
  });
  it("writes nothing for a note-only or unchanged update", () => {
    expect(historyAdjustmentForUpdate(open(1000), open(1000), 1000)).toBeNull();
    expect(historyAdjustmentForUpdate(settled(1000), settled(1000), 0)).toBeNull();
  });
  it("brings a reopened debt's history to its amount", () => {
    expect(historyAdjustmentForUpdate(settled(1000), open(1000), 0)).toEqual({ deltaMinor: 1000, reason: "reopened" });
    expect(historyAdjustmentForUpdate(settled(1000), open(700), 0)).toEqual({ deltaMinor: 700, reason: "reopened" });
  });
  it("writes nothing when a reopened debt's history already matches", () => {
    expect(historyAdjustmentForUpdate(settled(1000), open(1000), 1000)).toBeNull();
  });
  it("writes nothing for an amount edit on a settled debt", () => {
    expect(historyAdjustmentForUpdate(settled(1000), settled(600), 0)).toBeNull();
  });
  it("brings the history to the new amount when an open debt is settled with an edit", () => {
    expect(historyAdjustmentForUpdate(open(1000), settled(1400), 1000)).toEqual({ deltaMinor: 400, reason: "manual amount edit" });
  });
});
