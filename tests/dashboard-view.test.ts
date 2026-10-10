import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardView } from "../src/components/dashboard-view";
import { createStore } from "../src/lib/store";

let database: Database.Database;
let store: ReturnType<typeof createStore>;

beforeEach(() => {
  database = new Database(":memory:");
  store = createStore(database);
  store.migrate();
});

afterEach(() => database.close());

describe("DashboardView", () => {
  it("retains the category-spending breakdown and quick-entry form", () => {
    const user = store.registerUser("dashboard_view", "hash");
    const wallet = store.createAccount(user.id, { name: "Wallet", type: "cash", openingMinor: 0 });
    const food = store.listCategories(user.id).find((category) => category.name === "Food")!;
    store.createTransaction(user.id, {
      kind: "expense",
      amountMinor: 2_500,
      accountId: wallet.id,
      categoryId: food.id,
      description: "Lunch",
      date: "2026-10-09",
    });

    const html = renderToStaticMarkup(createElement(DashboardView, {
      initial: store.getDashboard(user.id, "2026-10-01", "2026-10-31"),
      categories: store.listCategories(user.id),
    }));

    expect(html).toContain("Spending by category");
    expect(html).toContain("Food");
    expect(html).toContain("₱25.00");
    expect(html).toContain("Quick entry");
    expect(html).toContain("Category");
    expect(html).toContain("Amount");
    expect(html).toContain("Add to ledger");
  });
});
