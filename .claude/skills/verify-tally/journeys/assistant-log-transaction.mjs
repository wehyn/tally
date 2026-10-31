// Settings opt-in -> Ask Tally widget -> scripted provider tool call -> recorded transaction card.
// The stub provider returns the queued log_transaction call; everything after that is Tally's real path.
import { readFileSync } from "node:fs";
import path from "node:path";
import { journey } from "../bin/driver.mjs";

await journey("assistant-log-transaction", async (t) => {
  const { page } = t;
  const description = `verify jeepney ${t.nonce}`;
  await t.login();

  await page.goto("/settings");
  const toggle = page.getByRole("switch", { name: "Enable hosted assistant" });
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await page.getByLabel(/I have read this disclosure/).check();
    await toggle.click();
    await page.getByRole("status").filter({ hasText: "Assistant enabled" }).waitFor();
  }
  await t.shot("settings-opted-in");
  t.check((await toggle.getAttribute("aria-checked")) === "true", "assistant opt-in switch is on");

  await t.queueProviderCall("log_transaction", { amount: "120", category: "Transport", description });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open Tally assistant" }).first().click();
  const prompt = page.locator("#assistant-widget-prompt");
  await prompt.fill(`Spent 120 on a jeepney ride (${t.nonce})`);
  await t.shot("prompt-typed");
  await page.getByRole("button", { name: "Send message" }).click();
  const card = page.getByRole("article", { name: "Recorded transaction" }).filter({ hasText: new RegExp(t.nonce, "i") });
  await card.waitFor({ timeout: 30_000 });
  await t.shot("transaction-recorded");
  t.check(await card.getByText(/120/).first().isVisible(), "chat shows a recorded-transaction card for PHP 120");

  const rows = t.db("SELECT t.kind, t.amount_minor, t.source, c.name AS category FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE lower(t.description) = lower(?)", description);  // the assistant capitalizes descriptions
  t.check(rows.length === 1 && rows[0].kind === "expense" && rows[0].amount_minor === 12000 && rows[0].source === "assistant" && rows[0].category === "Transport", "one assistant expense row in SQLite", rows);
  const sent = readFileSync(path.join(t.env.RUN_DIR, "evidence", "provider-requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  t.check(sent.messages.at(-1).content === `Spent 120 on a jeepney ride (${t.nonce})` && sent.tools.includes("log_transaction"), "provider received the typed prompt with Tally's tool list", { last: sent.messages.at(-1), tools: sent.tools });
});
