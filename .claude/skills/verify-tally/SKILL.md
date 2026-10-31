---
name: verify-tally
description: Launch an isolated Tally (Next.js + SQLite personal finance app) dev instance with a scripted stub LLM provider, drive its web UI with Playwright as a signed-in user, and capture screenshot/trace/DB evidence. Use when you need to prove a Tally change works in the real app (transactions, accounts, debts, Ask Tally assistant, auth), not just in vitest.
---

# Verify Tally

Tally's surface is a **web UI** (Next.js App Router, `src/app`). Secondary surfaces: the JSON API under `/api/*` (the UI's own backend) and the Apple Shortcuts endpoint `POST /api/shortcuts/assistant` (bearer credential from Settings). There is no CLI.

Everything below is run from the checkout root. All helpers live in `.claude/skills/verify-tally/bin/` and are executable. `S=.claude/skills/verify-tally` in the snippets.

## What a run looks like

```sh
S=.claude/skills/verify-tally
$S/bin/launch.sh                      # prints: READY run=/tmp/tally-verify/<id> base=http://127.0.0.1:<port> user=verifier
RUN=/tmp/tally-verify/<id>            # copy from the READY line
$S/bin/doctor.sh "$RUN"               # every line must be "ok"
node $S/journeys/transactions-add.mjs "$RUN"   # prints PASS/FAIL per check, then JOURNEY PASS|FAIL
$S/bin/cleanup.sh "$RUN"              # stops only this run's processes; evidence survives
```

## Launch

`bin/launch.sh [run-id]` (run id defaults to a timestamp) does, in order:

1. **Refuses** if any `next dev`/`next-server` process already has this checkout as its cwd. Next locks `.next/dev`, so one dev server per checkout. To verify in parallel, use another git worktree; never drive or kill a server you did not start.
2. Runs `npm ci` if `node_modules/next` is missing, and `npx playwright install chromium` (a no-op when cached).
3. Creates `/tmp/tally-verify/<run-id>/{data,evidence,logs}` (override the root with `TALLY_VERIFY_ROOT`). The DB is `data/tally.sqlite` via `TALLY_DATA_DIR`, so the user's `.dev-data/` is never touched.
4. Starts `bin/stub-provider.mjs` on a free port. Then it starts `npx next dev -H 127.0.0.1 -p <free port>` (set `TALLY_VERIFY_PORT` to pin it) with `CODEX_LB_BASE_URL=http://127.0.0.1:<stub>/v1` plus a model, key, and disclosure. In dev mode, Tally accepts plain HTTP for 127.0.0.1 providers. Each process runs in its own session and records its process-group id in `next.pid` / `stub.pid`.
5. Waits for `/api/health`, then for `/login` to render. **Next 16 quirk:** when it detects an agent, `next dev` may print a security "upgrade recommendation" a few seconds after the first request and exit, saying to retry. The launcher restarts it once for that specific exit (logged as `note: ... restarting once`). Do not run `next upgrade` as part of verification; that is the user's call.
6. Seeds through the real HTTP API: registers `verifier` / `verify-password-123` (the first user becomes admin, which runs migrations and creates the starter categories) and creates the cash account `Wallet` with balance PHP 1,000.00 (the default account).
7. Writes `run.env` (`BASE_URL`, `STUB_URL`, `DB_PATH`, `TALLY_USER`, `TALLY_PASS`, `RUN_DIR`, `REPO`) and prints `READY ...`. **READY means usable:** a user can sign in and has an account.

Cold start is about 20 s. If launch fails, it prints the cleanup command to run. Read `$RUN/logs/next.log` first.

Seeded state: user `verifier` (admin, assistant **not** opted in), account `Wallet` (cash, default, PHP 1,000.00), starter categories (income: Salary, Other income; expense: Food, Transport, Housing, Utilities, Health, Shopping, Education, Entertainment, Travel, Other). No transactions, debts, bills, or goals.

## Doctor

`bin/doctor.sh "$RUN"` is read-only and exits non-zero if any check fails. It checks that both recorded process groups are alive, that `/api/health` reports `service: tally`, and that the stub answers. It confirms that the app port's listener belongs to this run's process group and that this run's DB file exists. It also checks that the seeded session cookie still lists `Wallet` and that `/api/settings` reports the provider as configured. Finally it prints the checkout's HEAD and dirty-file count, so you know which code you are proving. Run it first whenever anything looks off. If it fails, clean up and relaunch rather than repairing in place.

## Drive

The harness is Playwright (`@playwright/test` from the repo's `node_modules`, Chromium headless) through `bin/driver.mjs`. A journey looks like this:

```js
import { journey } from "../bin/driver.mjs";
await journey("my-feature", async (t) => {
  await t.login();                         // real /login form, waits for /dashboard
  await t.page.goto("/debts");
  await t.shot("before");                  // -> evidence/my-feature/01-before.png
  // ... drive with roles/labels ...
  t.check(condition, "what this proves", detailForTheLog);
  t.db("SELECT ... WHERE x = ?", value);   // read-only query of this run's SQLite
  await t.api("/api/accounts");            // GET as the signed-in user (same cookies)
  await t.queueProviderCall("log_debt", { direction: "owed_to_you", counterparty: "Mina", amount: "500" });
});
```

Run it with `node .claude/skills/verify-tally/journeys/<name>.mjs "$RUN"`. `t.nonce` is unique per attempt; put it in any text you create so repeated runs on one instance don't collide. The viewport is 1366×900 in `Asia/Manila`. Pass `{ mobile: true }` as the third `journey()` argument for 390×844 (mobile bottom navigation).

Stable handles (see `features/` for each feature's full recipe):
- Desktop nav: `getByRole("navigation", { name: "Main navigation" })` with links `Home`, `Money`, `Plan`. Sub-pages are `/transactions`, `/accounts`, `/bills`, `/debts`, `/goals`, and `/settings`, reached from the account menu `"<username> account menu"`.
- Dialogs: `getByRole("dialog", { name: "Add transaction" | "New financial account" | "Add a debt" | ... })`. Fields are `<label>`-wrapped, so use `getByLabel("Amount in PHP")`.
- Ask Tally widget: button `Open Tally assistant` (use `.first()`, since two exist), textarea `#assistant-widget-prompt`, button `Send message`, and result cards `getByRole("article", { name: "Recorded transaction" })`.

**Stub provider.** Ask Tally calls an external LLM. Locally that boundary is `bin/stub-provider.mjs`, which returns whatever tool call you queued (`t.queueProviderCall(name, args)` or `curl -X POST $STUB_URL/__queue -d '{"name":"...","args":{...}}'`). With an empty queue it returns `ask_clarification`. Tool names: `log_transaction`, `log_debt`, `record_debt_payment`, `record_debt_repayment`, `finance_question`, `create_bill`, `update_bill`, `ask_clarification` (schemas in `src/lib/provider.ts`). This proves Tally's handling of a provider decision: validation, local guards, writes, and UI. It does **not** prove the real model would choose that tool. Say so in any report. Tally's local repayment guards can override the queued call, which is behavior worth asserting.

## Evidence

Everything goes to `$RUN/evidence/`, which cleanup never deletes:
- `<journey>/NN-<step>.png`: full-page screenshots before the action, mid-action, and after.
- `<journey>/trace.zip`: a Playwright trace of every action with DOM snapshots. Open it with `npx playwright show-trace <path>`.
- `<journey>/console.log`: browser console errors and warnings, plus page errors. Empty is expected.
- `<journey>/result.json`: each check with pass/fail and detail.
- `provider-requests.jsonl`: one line per call Tally made to the provider. It holds the non-system messages, the tool list, whether auth was present, and what the stub returned. Use it to prove what data left the app (for example, that a counterparty name appears only in the untrusted-context message).
- `$RUN/logs/next.log` and `stub.log`: server logs, which also survive cleanup.

Proof standards:
- Drive the real user path: the UI a person would click. Don't call internal setters, write SQL, or use API shortcuts for the action under test. API/DB reads are for **verifying** side effects only. Launch seeding through the API is a precondition, not the thing being proved.
- Capture the action and the resulting state, not just the final screen.
- Verify side effects alongside the UI: balance changes via `t.api("/api/accounts")`, rows via `t.db(...)`, and provider traffic via `provider-requests.jsonl`.
- The stub is the only mock, and it sits exactly at the production provider boundary (`CODEX_LB_BASE_URL`). Nothing else is mocked.
- A journey whose precondition the seed lacks must fail and record why. Never weaken the assertion to make it pass.

## Cleanup

`bin/cleanup.sh "$RUN"` sends TERM to the recorded process groups (`next.pid`, `stub.pid`), waits for every member to exit, then sends KILL to anything left. It deletes `$RUN/data` and the cookie jar and keeps `$RUN/evidence` and `$RUN/logs`. It never kills by process name. Run it after every launch, including failed ones. To discard evidence, `rm -rf /tmp/tally-verify/<id>` yourself once the proof has been reported. `/tmp` may be wiped on reboot, so copy the evidence elsewhere if it must last.

## Helpers

| Helper | Invocation |
|---|---|
| `bin/launch.sh` | `bin/launch.sh [run-id]` → `READY run=<dir> ...` |
| `bin/doctor.sh` | `bin/doctor.sh <run-dir>` → `ok`/`FAIL` lines, exit 0 only if all ok |
| `bin/cleanup.sh` | `bin/cleanup.sh <run-dir>` |
| `bin/stub-provider.mjs` | started by launch; `POST /__queue {name,args}`, `GET /__health` |
| `bin/driver.mjs` | `import { journey } from "../bin/driver.mjs"` |
| `journeys/transactions-add.mjs` | `node journeys/transactions-add.mjs <run-dir>` |
| `journeys/assistant-log-transaction.mjs` | `node journeys/assistant-log-transaction.mjs <run-dir>` |

Write new journeys next to these. Keep one file per feature path, and add it to that feature's map entry.

## Feature map

`features/README.md` indexes the user-facing features and gives a recipe for each. A proof is incomplete if it drives only one entry point when the map lists others. After changing a feature, update its map file.
