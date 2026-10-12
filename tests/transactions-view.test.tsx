// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../src/lib/store";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { TransactionsView } from "../src/components/transactions-view";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
    const container = renderTransactions(transactions);
    const rows = [...container.querySelectorAll(".list-table tbody tr")];

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

    expect(container.querySelector(".transaction-date-heading time")?.textContent).toBe("October 11, 2026");
    expect(rows[0].querySelectorAll("td")[1].textContent).toContain("Food");
    expect(rows[0].querySelectorAll("td")[0].querySelector(".table-muted")?.textContent).toBe("12:30");
    expect(rows[0].querySelectorAll("td")[2].textContent).toBe("Wallet");
    expect(rows[0].querySelectorAll("td")[3].textContent).toBe("−₱25.00");
    expect(rows[0].querySelector('[aria-label="Edit Lunch"]')).not.toBeNull();
    expect(rows[0].querySelector('[aria-label="Permanently delete Lunch"]')).not.toBeNull();
    expect(rows[2].querySelector('a[href="/accounts"]')?.textContent).toBe("Manage");
  });

  it("keeps the Undo action for an assistant transaction with time remaining", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(TransactionsView, {
        initial: [makeTransaction({ source: "assistant", undoUntil: "2099-01-01T00:00:00.000Z" })],
        initialAccounts: [],
        initialCategories: [],
      })));

      expect(container.querySelector(".table-actions button")?.textContent).toBe("Undo");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
