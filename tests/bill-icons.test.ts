import { describe, expect, it } from "vitest";
import { isBillIconEmoji, selectBillIconPreset } from "../src/lib/bill-icons";

describe("bill icon emoji validation", () => {
  it("accepts composite emojis represented by one grapheme", () => {
    expect(isBillIconEmoji("👨‍👩‍👧‍👦")).toBe(true);
    expect(isBillIconEmoji("1️⃣")).toBe(true);
  });

  it("rejects two adjacent emoji graphemes", () => {
    expect(isBillIconEmoji("😀😀")).toBe(false);
  });

  it("clears a custom emoji when a preset icon is selected", () => {
    const draft = { icon: "calendar" as const, iconEmoji: "🎉", name: "Internet" };

    expect(selectBillIconPreset(draft, "netflix")).toEqual({ icon: "netflix", iconEmoji: "", name: "Internet" });
  });
});
