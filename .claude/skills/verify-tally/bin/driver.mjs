// Shared Playwright harness for verify-tally journeys. Import from a journey:
//   import { start } from "../bin/driver.mjs";
//   const t = await start("journey-name");   // run dir from argv[2] or $TALLY_VERIFY_RUN
//   await t.login(); await t.shot("01-before"); ... t.check(cond, "label"); await t.finish();
// Evidence goes to <run>/evidence/<journey>/: numbered screenshots, trace.zip, console.log, result.json.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import Database from "better-sqlite3";

export async function start(journey, { mobile = false } = {}) {
  const runDir = process.argv[2] ?? process.env.TALLY_VERIFY_RUN;
  if (!runDir) throw new Error("usage: node <journey>.mjs <run-dir>");
  const env = Object.fromEntries(readFileSync(path.join(runDir, "run.env"), "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const out = path.join(runDir, "evidence", journey);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: env.BASE_URL, viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 }, timezoneId: "Asia/Manila" });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const checks = [];
  const consoleLines = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) consoleLines.push(`[${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  let n = 0;
  const t = {
    env, page, out,
    nonce: `${env.RUN_ID}-${Date.now().toString(36)}`, // unique per attempt, so journeys can repeat on one instance
    async login() {
      await page.goto("/login");
      await page.getByLabel("Username").fill(env.TALLY_USER);
      await page.getByLabel("Password", { exact: true }).fill(env.TALLY_PASS);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL("**/dashboard");
    },
    async shot(name) { await page.screenshot({ path: path.join(out, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true, caret: "initial" }); }, // caret hiding edits inline styles and trips React hydration warnings
    // Read-only view of this run's SQLite file for side-effect checks.
    db(sql, ...params) { const db = new Database(env.DB_PATH, { readonly: true, fileMustExist: true }); try { return db.prepare(sql).all(...params); } finally { db.close(); } },
    async api(route) { const r = await page.request.get(route); return r.json(); },
    async queueProviderCall(name, args) { const r = await fetch(`${env.STUB_URL}/__queue`, { method: "POST", body: JSON.stringify({ name, args }) }); if (!r.ok) throw new Error(`stub queue failed: ${r.status}`); },
    check(ok, label, detail) { checks.push({ ok: Boolean(ok), label, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`); },
    async finish(error) {
      if (error) { checks.push({ ok: false, label: "journey threw", detail: String(error?.stack ?? error) }); console.error(error); await t.shot("error").catch(() => {}); }
      await context.tracing.stop({ path: path.join(out, "trace.zip") });
      await browser.close();
      writeFileSync(path.join(out, "console.log"), consoleLines.join("\n"));
      const pass = checks.length > 0 && checks.every((c) => c.ok);
      writeFileSync(path.join(out, "result.json"), JSON.stringify({ journey, pass, at: new Date().toISOString(), checks }, null, 2));
      console.log(`${pass ? "JOURNEY PASS" : "JOURNEY FAIL"} ${journey} -> ${out}`);
      process.exitCode = pass ? 0 : 1;
    },
  };
  return t;
}

// Wrap a journey body so failures still write trace + result.json.
export async function journey(name, body, options) {
  const t = await start(name, options);
  try { await body(t); await t.finish(); } catch (error) { await t.finish(error); }
}
