import { describe, expect, it } from "vitest";
import { formatPHP, formatPHPFromMinorString, parsePHPToMinor } from "../src/lib/money";

describe("PHP minor-unit amounts", () => {
  it("parses whole and fractional peso amounts exactly", () => {
    expect(parsePHPToMinor("250")).toBe(25000);
    expect(parsePHPToMinor("₱1,234.05")).toBe(123405);
    expect(parsePHPToMinor("0.01")).toBe(1);
    expect(parsePHPToMinor("0.00", { allowZero: true })).toBe(0);
  });

  it("rejects malformed, negative, zero, and over-precision amounts", () => {
    for (const value of ["", "0", "-1", "1.001", "12,34", "₱₱2", "1e3"]) {
      expect(() => parsePHPToMinor(value), value).toThrow();
    }
  });

  it("formats serialized minor-unit totals without floating-point loss", () => {
    expect(formatPHPFromMinorString("123405")).toBe("₱1,234.05");
    expect(formatPHPFromMinorString("900719925474099300")).toBe("₱9,007,199,254,740,993.00");
    expect(formatPHPFromMinorString("-105")).toBe("-₱1.05");
    expect(() => formatPHPFromMinorString("1.5")).toThrow(/integer/);
  });

  it("formats integer minor units without losing cents", () => {
    expect(formatPHP(123405)).toBe("₱1,234.05");
    expect(formatPHP(0)).toBe("₱0.00");
    expect(formatPHP(-105)).toBe("-₱1.05");
  });
});
