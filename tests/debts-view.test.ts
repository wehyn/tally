// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DebtsView } from "../src/components/debts-view";
import type { Debt } from "../src/lib/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const records: Debt[] = [
  { id: "owed-1", direction: "owed_to_you", counterparty: "Mina", amountMinor: 12_500, note: "Trip costs", dueDate: "2026-11-15", status: "open", createdAt: "2026-10-10T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z" },
  { id: "owe-1", direction: "you_owe", counterparty: "Sam", amountMinor: 8_000, note: "", dueDate: null, status: "open", createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z" },
];

describe("DebtsView", () => {
  it("shows separate owed-to-you and you-owe sections with outstanding totals", () => {
    const html = renderToStaticMarkup(createElement(DebtsView, { initial: records }));

    expect(html).toContain("Owed to you");
    expect(html).toContain("You owe");
    expect(html).toContain("₱125.00");
    expect(html).toContain("₱80.00");
    expect(html).toContain("Mina");
    expect(html).toContain("Sam");
    expect(html).toContain("Trip costs");
  });

  it("explains that debt records are separate from the account ledger", () => {
    const html = renderToStaticMarkup(createElement(DebtsView, { initial: [] }));

    expect(html).toContain("separate from your financial accounts and transaction totals");
    expect(html).toContain("Nothing outstanding");
    expect(html).toContain("Add a debt someone owes you.");
  });

  it("labels the retained amount on settled debts", async () => {
    const settled: Debt = { id: "settled-1", direction: "owed_to_you", counterparty: "Lani", amountMinor: 10_000, note: "", dueDate: null, status: "settled", createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z" };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(createElement(DebtsView, { initial: [...records, settled] })));
    const allDebtsButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("All debts"));
    await act(async () => allDebtsButton?.click());

    const settledRow = container.querySelector(".debt-row.settled");
    expect(settledRow?.textContent).toContain("₱100.00");
    expect(settledRow?.textContent).toContain("Settled · last outstanding balance");

    await act(async () => root.unmount());
  });
});
