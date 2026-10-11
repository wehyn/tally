// @vitest-environment jsdom

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/dashboard-view";
import { createStore } from "../src/lib/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let database: Database.Database;
let store: ReturnType<typeof createStore>;
const globalStyles = readFileSync("src/app/globals.css", "utf8");

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
});

afterEach(() => database.close());

function dashboardData() {
  const user = store.registerUser("dashboard_view", "hash");
  const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 10_000 });
  const overdrawn = store.createAccount(user.id, { name: "Overdrawn account", type: "bank", openingMinor: 0 });
  const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
  store.createTransaction(user.id, {
    kind: "expense",
    amountMinor: 2_500,
    accountId: wallet.id,
    categoryId: food.id,
    description: "Lunch",
    date: "2026-10-09",
  });
  store.createTransaction(user.id, {
    kind: "expense",
    amountMinor: 5_000,
    accountId: overdrawn.id,
    categoryId: food.id,
    description: "Overdrawn purchase",
    date: "2026-10-09",
  });

  return store.getDashboard(user.id, "2026-10-01", "2026-10-31");
}

function renderDashboard() {
  return renderToStaticMarkup(createElement(DashboardView, { initial: dashboardData() }));
}

describe("DashboardView", () => {
  it("shows the selected date range and controls without redundant period decoration", () => {
    const period = renderDashboard().match(/<section class="period-row">([\s\S]*?)<\/section>/)?.[1] ?? "";
    const inputs = period.match(/<input\b[^>]*>/g) ?? [];
    const dateInputValues = inputs
      .filter((input) => /\btype="date"/.test(input))
      .map((input) => input.match(/\bvalue="([^"]+)"/)?.[1]);

    expect(period).toContain("2026-10-01 — 2026-10-31");
    expect(period).not.toContain("Showing actuals");
    expect(period).not.toMatch(/<svg\b/);
    expect(dateInputValues).toEqual(["2026-10-01", "2026-10-31"]);
    expect(period).toMatch(/<button\b(?=[^>]*\btype="submit")[^>]*>Apply<\/button>/);
    expect(period).toMatch(/<button\b(?=[^>]*\btype="button")[^>]*>Month to date<\/button>/);
  });

  it("requests the selected dates when Apply is submitted", async () => {
    const initial = dashboardData();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => initial });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(DashboardView, { initial })));
      const [start, end] = [...container.querySelectorAll<HTMLInputElement>('.date-range-form input[type="date"]')];
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setInputValue.call(start, "2026-10-05");
        start.dispatchEvent(new Event("input", { bubbles: true }));
        setInputValue.call(end, "2026-10-09");
        end.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector<HTMLFormElement>(".date-range-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/dashboard?start=2026-10-05&end=2026-10-09");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("requests the Manila month-to-date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T16:00:00.000Z"));
    const initial = dashboardData();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => initial });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(DashboardView, { initial })));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.date-range-form button[type="button"]')!.click();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/dashboard?start=2026-10-01&end=2026-10-12");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("shows total balance alongside the period summary and Assets", () => {
    const html = renderDashboard();
    const totalBalanceCard = html.match(/<article class="stat-card">[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(html).toContain("Total balance");
    expect(totalBalanceCard).toContain("₱25.00");
    expect(html).toContain("Income");
    expect(html).toContain("Spending");
    expect(html).toContain("Net activity");
    expect(html).toContain("Assets");
    expect(html).toContain("₱75.00");
    expect(html).toContain("Recent activity");
    expect(html.match(/class="stat-card"/g)).toHaveLength(4);
  });

  it("sums balances exactly when an intermediate total exceeds the safe-integer limit", () => {
    const user = store.registerUser("dashboard_large_balance", "hash");
    store.createAccount(user.id, { name: "Largest balance", type: "bank", openingMinor: Number.MAX_SAFE_INTEGER });
    const laterPositive = store.createAccount(user.id, { name: "Later positive", type: "bank", openingMinor: 0 });
    const negativeOffset = store.createAccount(user.id, { name: "Negative offset", type: "bank", openingMinor: 0 });
    const offsetMinor = 4_503_599_627_370_494;
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;

    store.createTransaction(user.id, {
      kind: "expense",
      amountMinor: offsetMinor,
      accountId: negativeOffset.id,
      categoryId: food.id,
      description: "Offset balance",
      date: "2026-10-09",
    });
    store.updateAccount(user.id, laterPositive.id, { openingMinor: offsetMinor });

    const initial = store.getDashboard(user.id, "2026-10-01", "2026-10-31");
    expect(initial.accounts.map((account) => account.balanceMinor)).toEqual([
      Number.MAX_SAFE_INTEGER,
      offsetMinor,
      -offsetMinor,
    ]);
    const html = renderToStaticMarkup(createElement(DashboardView, { initial }));
    const totalBalanceCard = html.match(/<article class="stat-card">[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(totalBalanceCard).toContain("₱90,071,992,547,409.91");
  });

  it("allows large balances to wrap inside narrow dashboard layouts", () => {
    const statValueStyles = globalStyles.match(/\.stat-value\{([^}]*)\}/)?.[1] ?? "";
    const assetValueRules = globalStyles.match(/\.asset-value\{[^}]*\}/g) ?? [];
    const mobileAssetValueStyles = assetValueRules[assetValueRules.length - 1] ?? "";
    expect(statValueStyles).toMatch(/overflow-wrap:\s*anywhere/);
    expect(mobileAssetValueStyles).toMatch(/white-space:\s*normal/);
    expect(mobileAssetValueStyles).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("does not render the category-spending or quick-entry panels", () => {
    const html = renderDashboard();
    expect(html).not.toContain("Spending by category");
    expect(html).not.toContain("Quick entry");
  });

  it("keeps category management off the dashboard", () => {
    const html = renderDashboard();
    expect(html).not.toContain("Add category");
  });
});
