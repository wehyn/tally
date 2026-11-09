import { describe, expect, it } from "vitest";
import { debtAfterPayment } from "../src/lib/lifecycle";

describe("debt lifecycle", () => {
  it("stays open with the remaining balance after a partial payment", () => {
    expect(debtAfterPayment(1000, 400)).toEqual({ amountMinor: 600, status: "open" });
  });
  it("settles on full payment and keeps the last outstanding balance", () => {
    expect(debtAfterPayment(1000, 1000)).toEqual({ amountMinor: 1000, status: "settled" });
  });
});
