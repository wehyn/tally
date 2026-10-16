// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isBillIconEmoji, selectBillIconPreset } from "../src/lib/bill-icons";
import { BillsView } from "../src/components/bills-view";
import type { Bill } from "../src/lib/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const logos = [
  { name: "Netflix", source: "/bill-logos/netflix.svg" },
  { name: "Shopee", source: "/bill-logos/shopee.svg" },
  { name: "PLDT", source: "/bill-logos/pldt.svg" },
];

const brandBills: Bill[] = [
  { id: "netflix", name: "Netflix", amountMinor: 15900, frequency: "monthly", nextDueDate: "2099-01-01", endDate: null, anchorDay: 1, anchorMonth: 1, accountId: "account", categoryId: "category", accountName: "Wallet", categoryName: "Subscriptions", archivedAt: null, icon: "netflix", iconEmoji: null, iconForegroundColor: "#5e9872", iconBackgroundColor: "#f0f5f0" },
  { id: "shopee", name: "Shopee", amountMinor: 2500, frequency: "monthly", nextDueDate: "2099-02-01", endDate: null, anchorDay: 1, anchorMonth: 2, accountId: "account", categoryId: "category", accountName: "Wallet", categoryName: "Shopping", archivedAt: null, icon: "shopee", iconEmoji: null, iconForegroundColor: "#5e9872", iconBackgroundColor: "#f0f5f0" },
  { id: "pldt", name: "PLDT", amountMinor: 169900, frequency: "monthly", nextDueDate: "2099-03-01", endDate: null, anchorDay: 1, anchorMonth: 3, accountId: "account", categoryId: "category", accountName: "Wallet", categoryName: "Internet", archivedAt: null, icon: "pldt", iconEmoji: null, iconForegroundColor: "#5e9872", iconBackgroundColor: "#f0f5f0" },
];

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

describe("BillsView brand icons", () => {
  it("bundles a valid SVG for every brand icon", () => {
    for (const { source } of logos) {
      const svg = readFileSync(resolve(process.cwd(), "public", source.slice(1)), "utf8");
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");

      expect(document.documentElement.localName).toBe("svg");
      expect(document.querySelector("parsererror")).toBeNull();
      expect([...document.querySelectorAll("path")].some((path) => Boolean(path.getAttribute("d")?.trim()))).toBe(true);
    }
  });

  it("uses the same local brand logos in saved bills and the picker without the automatic-expense notice", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(BillsView, { initialBills: brandBills, accounts: [], categories: [] })));

      const savedBillSources = logos.map(({ name }) => {
        const row = [...container.querySelectorAll(".activity-row")].find((item) => item.querySelector(".activity-copy strong")?.textContent === name);
        return row?.querySelector("img")?.getAttribute("src") ?? null;
      });
      const automaticExpenseNotice = /Bills due today or earlier are automatically recorded as expenses, even without payment confirmation\./.test(container.textContent ?? "");

      const addBill = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add a bill"));
      await act(async () => addBill?.click());

      const pickerSources = logos.map(({ name }) => {
        const choice = container.querySelector(`button[aria-label="Choose ${name} icon"]`);
        return choice?.querySelector("img")?.getAttribute("src") ?? null;
      });
      expect({ savedBillSources, pickerSources, automaticExpenseNotice }).toEqual({
        savedBillSources: logos.map(({ source }) => source),
        pickerSources: logos.map(({ source }) => source),
        automaticExpenseNotice: false,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
