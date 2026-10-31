// Manual expense via Transactions > Add transaction; proves ledger row, balance change, and DB row.
import { journey } from "../bin/driver.mjs";

await journey("transactions-add", async (t) => {
  const { page } = t;
  const description = `verify coffee ${t.nonce}`;
  await t.login();
  const before = (await t.api("/api/accounts")).accounts.find((a) => a.name === "Wallet");
  await page.goto("/transactions");
  await t.shot("transactions-before");
  await page.getByRole("button", { name: "Add transaction" }).click();
  const dialog = page.getByRole("dialog", { name: "Add transaction" });
  await dialog.getByLabel("Amount in PHP").fill("250.00");
  await dialog.getByLabel("Financial account").selectOption({ label: "Wallet · default" });
  await dialog.getByLabel("Description (optional)").fill(description);
  await dialog.getByLabel("Category").selectOption({ label: "Food · expense" });
  await t.shot("dialog-filled");
  await dialog.getByRole("button", { name: "Save transaction" }).click();
  await dialog.waitFor({ state: "hidden" });
  const row = page.getByRole("row").filter({ hasText: description });
  await row.waitFor();
  await t.shot("transactions-after");
  t.check(await row.isVisible(), "ledger shows the new row", description);
  const after = (await t.api("/api/accounts")).accounts.find((a) => a.name === "Wallet");
  t.check(BigInt(before.balanceMinor) - BigInt(after.balanceMinor) === 25000n, "Wallet balance dropped by PHP 250.00", { before: before.balanceMinor, after: after.balanceMinor });
  const rows = t.db("SELECT kind, amount_minor, source, description FROM transactions WHERE description = ?", description);
  t.check(rows.length === 1 && rows[0].kind === "expense" && rows[0].amount_minor === 25000 && rows[0].source === "manual", "one manual expense row in SQLite", rows);
});
