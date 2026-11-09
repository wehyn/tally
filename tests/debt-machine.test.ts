import { describe, expect, it } from "vitest";
import { acceptsAdvance, acceptsPayment, canChangeDirection, debtAfterPayment, nextDebtStatus } from "../src/lib/machines/debt";

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
