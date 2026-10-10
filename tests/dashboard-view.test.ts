import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardView } from "../src/components/dashboard-view";
import { createStore } from "../src/lib/store";

let database: Database.Database;
let store: ReturnType<typeof createStore>;
const globalStyles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
});

afterEach(() => database.close());

function renderDashboard() {
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

  return renderToStaticMarkup(createElement(DashboardView, {
    initial: store.getDashboard(user.id, "2026-10-01", "2026-10-31"),
  }));
}

describe("DashboardView", () => {
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
