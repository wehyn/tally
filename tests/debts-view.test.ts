// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DebtsView } from "../src/components/debts-view";
import { DEBTS_UPDATED_EVENT } from "../src/lib/client-events";
import type { Debt } from "../src/lib/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const records: Debt[] = [
  { id: "owed-1", direction: "owed_to_you", counterparty: "Mina", amountMinor: 12_500, note: "Trip costs", dueDate: "2026-11-15", status: "open", createdAt: "2026-10-10T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z", activity: [] },
  { id: "owe-1", direction: "you_owe", counterparty: "Sam", amountMinor: 8_000, note: "", dueDate: null, status: "open", createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z", activity: [] },
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

    expect(html).toContain("Debt balances are separate from account totals.");
    expect(html).toContain("Assistant advances are added to Transactions only when you ask");
    expect(html).toContain("Nothing outstanding");
    expect(html).toContain("Add a debt someone owes you.");
  });

  it("labels the retained amount on settled debts", async () => {
    const settled: Debt = { id: "settled-1", direction: "owed_to_you", counterparty: "Lani", amountMinor: 10_000, note: "", dueDate: null, status: "settled", createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z", activity: [] };
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

  it("groups same-person debts by normalized name and shows each linked movement chronologically", async () => {
    const grouped: Debt[] = [
      {
        id: "mina-1", direction: "owed_to_you", counterparty: " Mina ", amountMinor: 12_500, note: "Trip costs", dueDate: null, status: "open",
        createdAt: "2026-10-10T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z",
        activity: [
          { transactionId: "advance", date: "2026-10-10", time: "12:00", kind: "expense", amountMinor: -12_500, categoryName: "Food", accountName: "Wallet", description: "Lunch advance" },
          { transactionId: "repayment", date: "2026-10-12", time: "09:30", kind: "income", amountMinor: 2_500, categoryName: "Other income", accountName: "Wallet", description: "Mina paid me" },
        ],
      },
      { id: "mina-2", direction: "owed_to_you", counterparty: "mina", amountMinor: 5_000, note: "", dueDate: null, status: "open", createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z", activity: [] },
      { id: "mina-settled", direction: "owed_to_you", counterparty: "MINA", amountMinor: 2_500, note: "", dueDate: null, status: "settled", createdAt: "2026-10-08T08:00:00.000Z", updatedAt: "2026-10-08T08:00:00.000Z", activity: [] },
      { id: "mina-owe", direction: "you_owe", counterparty: "MINA", amountMinor: 7_000, note: "", dueDate: null, status: "open", createdAt: "2026-10-07T08:00:00.000Z", updatedAt: "2026-10-07T08:00:00.000Z", activity: [] },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(createElement(DebtsView, { initial: grouped })));
    const allDebtsButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("All debts"));
    await act(async () => allDebtsButton?.click());

    const panels = [...container.querySelectorAll(".debt-panel")];
    const owedPanel = panels.find((panel) => panel.querySelector("h2")?.textContent === "Owed to you")!;
    const youOwePanel = panels.find((panel) => panel.querySelector("h2")?.textContent === "You owe")!;
    const owedGroup = owedPanel.querySelector(".debt-person-group")!;
    expect(container.querySelectorAll(".debt-person-group")).toHaveLength(2);
    expect(owedPanel.querySelectorAll(".debt-person-group")).toHaveLength(1);
    expect(youOwePanel.querySelectorAll(".debt-person-group")).toHaveLength(1);
    expect(owedGroup.querySelector("h3")?.textContent).toBe("Mina");
    expect(owedGroup.querySelectorAll(".debt-row")).toHaveLength(3);
    expect(owedGroup.textContent).toContain("3 records");
    expect(owedGroup.textContent).toContain("₱175.00");
    expect(owedGroup.textContent).toContain("Settled · last outstanding balance");
    expect(owedGroup.textContent).toContain("No linked transaction history");
    const activityLines = [...owedGroup.querySelectorAll(".debt-activity-item")].map((line) => line.textContent ?? "");
    expect(activityLines).toHaveLength(2);
    expect(activityLines[0]).toContain("Food");
    expect(activityLines[0]).toContain("-₱125.00");
    expect(activityLines[1]).toContain("Other income");
    expect(activityLines[1]).toContain("₱25.00");
    expect(activityLines[0].indexOf("Oct 10")).toBeGreaterThanOrEqual(0);
    expect(activityLines[1].indexOf("Oct 12")).toBeGreaterThanOrEqual(0);
    expect(youOwePanel.textContent).toContain("₱70.00");

    await act(async () => root.unmount());
  });

  it("preserves stored order for same-time activity and gives repeated debt actions distinct names", async () => {
    const repeated: Debt[] = [
      {
        id: "mina-first", direction: "owed_to_you", counterparty: "Mina", amountMinor: 10_000, note: "", dueDate: null, status: "open",
        createdAt: "2026-10-10T08:00:00.000Z", updatedAt: "2026-10-10T08:00:00.000Z",
        activity: [
          { transactionId: "z-first", date: "2026-10-10", time: "09:00", kind: "expense", amountMinor: -10_000, categoryName: "Food", accountName: "Wallet", description: "First saved" },
          { transactionId: "a-second", date: "2026-10-10", time: "09:00", kind: "income", amountMinor: 2_000, categoryName: "Other income", accountName: "Wallet", description: "Second saved" },
        ],
      },
      { id: "mina-second", direction: "owed_to_you", counterparty: "mina", amountMinor: 5_000, note: "", dueDate: null, status: "open", createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z", activity: [] },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(createElement(DebtsView, { initial: repeated })));
    const actionNames = [...container.querySelectorAll(".debt-row-actions button")].map((button) => button.getAttribute("aria-label"));
    const activityDescriptions = [...container.querySelectorAll(".debt-activity-item")].map((line) => line.textContent ?? "");

    expect(new Set(actionNames).size).toBe(actionNames.length);
    expect(activityDescriptions[0]).toContain("First saved");
    expect(activityDescriptions[1]).toContain("Second saved");

    await act(async () => root.unmount());
  });

  it("refreshes a debt's linked activity from the assistant debt-update event", async () => {
    const before = records[0];
    const updated: Debt = {
      ...before,
      amountMinor: 10_000,
      activity: [{ transactionId: "payment", date: "2026-10-12", time: "09:30", kind: "income", amountMinor: 2_500, categoryName: "Other income", accountName: "Wallet", description: "Mina paid me" }],
    };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(createElement(DebtsView, { initial: records })));
    await act(async () => window.dispatchEvent(new CustomEvent<Debt>(DEBTS_UPDATED_EVENT, { detail: updated })));

    expect(container.querySelector(".debt-person-group")?.textContent).toContain("Other income");
    expect(container.querySelector(".debt-person-group")?.textContent).toContain("₱25.00");

    await act(async () => root.unmount());
  });
});
