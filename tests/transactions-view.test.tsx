// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../src/lib/store";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { TransactionsView } from "../src/components/transactions-view";

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "transaction-1",
    kind: "expense",
    amountMinor: 2_500,
    accountId: "wallet",
    categoryId: "food",
    description: "Lunch",
    date: "2026-10-11",
    time: "12:30",
    source: "manual",
    categoryName: "Food",
    categoryIcon: "utensils",
    accountName: "Wallet",
    destinationAccountName: null,
    undoUntil: null,
    ...overrides,
  };
}

function renderTransactions(transactions: Transaction[]) {
  const html = renderToStaticMarkup(createElement(TransactionsView, {
    initial: transactions,
    initialAccounts: [],
    initialCategories: [],
  }));
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("TransactionsView", () => {
  it("shows each transaction's leading category or transfer glyph without changing row order", () => {
    const transactions = [
      makeTransaction(),
      makeTransaction({
        id: "transaction-2",
        description: "Uncategorized purchase",
        categoryName: "Legacy category",
        categoryIcon: null,
      }),
      makeTransaction({
        id: "transaction-3",
        kind: "transfer",
        categoryId: undefined,
        description: "Move to savings",
        categoryName: null,
        categoryIcon: null,
        destinationAccountName: "Savings",
      }),
    ];
    const rows = [...renderTransactions(transactions).querySelectorAll(".list-table tbody tr")];

    expect(rows.map((row) => row.querySelector(".table-title")?.textContent)).toEqual([
      "Lunch",
      "Uncategorized purchase",
      "Move to savings",
    ]);

    const expectedIcons = [
      ["expense", "lucide-utensils"],
      ["expense", "lucide-tag"],
      ["transfer", "lucide-arrow-left-right"],
    ];
    rows.forEach((row, index) => {
      const cell = row.querySelector(".transaction-title-cell");
      const iconWrapper = cell?.querySelector(".activity-icon");
      const icon = iconWrapper?.querySelector("svg");
      const [kind, glyphClass] = expectedIcons[index];

      expect(cell).not.toBeNull();
      expect(iconWrapper).not.toBeNull();
      expect(iconWrapper?.classList.contains(kind)).toBe(true);
      expect(icon?.classList.contains(glyphClass)).toBe(true);
      expect(cell?.firstElementChild).toBe(iconWrapper);
    });

    expect(rows[0].querySelector('[aria-label="Edit Lunch"]')).not.toBeNull();
    expect(rows[0].querySelector('[aria-label="Permanently delete Lunch"]')).not.toBeNull();
    expect(rows[2].querySelector('a[href="/accounts"]')?.textContent).toBe("Manage");
  });
});
