import { describe, expect, it } from "vitest";
import { isBillIconEmoji } from "../src/lib/bill-icons";

describe("bill icon emoji validation", () => {
  it("accepts composite emojis represented by one grapheme", () => {
    expect(isBillIconEmoji("👨‍👩‍👧‍👦")).toBe(true);
    expect(isBillIconEmoji("1️⃣")).toBe(true);
  });

  it("rejects two adjacent emoji graphemes", () => {
    expect(isBillIconEmoji("😀😀")).toBe(false);
  });
});
