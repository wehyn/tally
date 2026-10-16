// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Bill, Category } from "../src/lib/store";

vi.mock("next/image", () => ({ default: () => null }));
import { BillsView } from "../src/components/bills-view";

/* These mount the real BillsView to protect end-date editing, archived visibility, and event-driven refresh. */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const account = { id: "account-1", name: "Wallet", type: "cash", balanceMinor: 0, isDefault: true } as Account;
const category = { id: "category-1", name: "Utilities", type: "expense" } as Category;
const bill: Bill = {
  id: "bill-1", name: "Internet", amountMinor: 50000, frequency: "monthly", nextDueDate: "2026-11-09", endDate: "2026-12-31",
  anchorDay: 9, anchorMonth: 11, accountId: account.id, categoryId: category.id, accountName: account.name, categoryName: category.name,
  archivedAt: null, icon: "calendar", iconEmoji: null, iconForegroundColor: "#ffffff", iconBackgroundColor: "#000000",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BillsView finite schedules", () => {
  it("shows and saves the editable end date", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => String(input) === "/api/bills" ? { bills: [bill] } : { bill: { ...bill, endDate: "2027-01-31" } },
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    await act(async () => root.render(createElement(BillsView, { initialBills: [bill], accounts: [account], categories: [category] })));
    await act(async () => user.click(container.querySelector<HTMLButtonElement>('[aria-label="Edit Internet"]')!));

    const endDate = container.querySelector<HTMLInputElement>('input[name="endDate"]');
    expect(endDate?.value).toBe("2026-12-31");
    await act(async () => { await user.clear(endDate!); await user.type(endDate!, "2027-01-31"); });
    await act(async () => user.click([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save changes"))!));

    const patch = fetchMock.mock.calls.find(([url]) => String(url) === "/api/bills/bill-1");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ endDate: "2027-01-31" });
  });

  it("shows an ended schedule in Archived with its end date", async () => {
    const archived = { ...bill, archivedAt: "2026-12-31T00:00:00.000Z", nextDueDate: "2027-01-09" };
    await act(async () => root.render(createElement(BillsView, { initialBills: [archived], accounts: [account], categories: [category] })));

    expect(container.textContent).toContain("Archived · next date was Jan 9");
    expect(container.textContent).toContain("Ended Dec 31, 2026");
  });

  it("does not show posting pending for an ended schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const ended = { ...bill, endDate: "2026-01-15", nextDueDate: "2026-01-20" };
    await act(async () => root.render(createElement(BillsView, { initialBills: [ended], accounts: [account], categories: [category] })));

    expect(container.textContent).toContain("Ended");
    expect(container.textContent).toContain("End date Jan 15, 2026");
    expect(container.textContent).not.toContain("Posting pending");
  });

  it("refreshes the list after a bill update event", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ bills: [bill] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(createElement(BillsView, { initialBills: [], accounts: [account], categories: [category] })));

    await act(async () => window.dispatchEvent(new Event("tally:bills-updated")));

    expect(fetchMock).toHaveBeenCalledWith("/api/bills");
    expect(container.textContent).toContain("Internet");
  });
});
