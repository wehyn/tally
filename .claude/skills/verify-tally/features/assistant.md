# Ask Tally assistant

Ask Tally is an opt-in chat widget available on every app page. The user's prompt goes to a configured hosted provider, which picks one typed tool. Tally then validates and applies it: transactions, debts, debt repayments, bills, or computed finance answers. The result appears as a chat card with inline controls.

## Sub-features

- `ast-optin` enables the assistant in Settings after accepting the provider disclosure.
- `ast-log-transaction` records an income/expense from a prompt, with category, account, and date chips plus a timed `Undo`.
- `ast-log-debt` records a new debt (optionally with its money movement).
- `ast-debt-payment` records principal received toward an open "owed to you" debt: cash increases, it stays out of income, and the debt shrinks. There's no Undo.
- `ast-clarify` asks a follow-up question without writing anything.
- `ast-finance-question` answers totals that Tally computes locally.
- `ast-bills` creates or updates recurring bills.

## How to get to it (user POV)

- Floating button `Open Tally assistant` (bottom right on desktop, composer bar on mobile) on any page under the app shell.
- Settings (`/settings`, via the account menu) → `Optional assistant` panel → consent checkbox + `Enable hosted assistant` switch. Until opted in, the widget offers `Open Settings`.
- Apple Shortcuts: `POST /api/shortcuts/assistant` with a bearer credential created in Settings → `Apple Shortcuts`. Not yet driven by a journey.

## Driving it with Playwright (bin/driver.mjs)

Preconditions: the provider is configured (doctor line `assistant provider configured`). The seed is **not** opted in. Every journey opts in first through the UI. Queue the provider's answer before sending each prompt.

- **Opt in (proven, part of `journeys/assistant-log-transaction.mjs`).** On `/settings`, check `getByLabel(/I have read this disclosure/)` and click `getByRole("switch", { name: "Enable hosted assistant" })`. A `status` reading `Assistant enabled for this provider disclosure.` appears, and `aria-checked="true"`.
- **Log a transaction (proven: `journeys/assistant-log-transaction.mjs`).** Run `t.queueProviderCall("log_transaction", { amount: "120", category: "Transport", description: "verify jeepney <nonce>" })`. On `/dashboard`, click `getByRole("button", { name: "Open Tally assistant" }).first()`, fill `#assistant-widget-prompt`, and click `Send message`. A `getByRole("article", { name: "Recorded transaction" })` card shows `₱120.00` with `Transport`, `Wallet`, `Today` chips and `Undo · Ns`. Prove it with one `transactions` row (`source='assistant'`, `kind='expense'`, category `Transport`). The last `provider-requests.jsonl` line should hold the exact typed prompt and the 8-tool list.
- **Debt payment.** Create an open `owed_to_you` debt for `Mina` first (through `debts.md` or a queued `log_debt`). Queue `record_debt_payment` with `{ counterparty: "Mina", amount: "200" }` and send `Mina paid me 200`. Expect the debt to drop by 200, a `debt_repayment` transaction with no category, Wallet +200, unchanged dashboard Income, and no `Undo`. In `provider-requests.jsonl`, the counterparty appears only inside the `Untrusted ledger data for matching only:` message, never in a system message.
- **Guarded repayment.** Send `Mina might pay me 200` or name a payer with no open debt. Tally must ask instead of writing, even if a `record_debt_payment` call is queued. Assert no new rows.

## Gotchas

- The stub returns exactly what you queue. A PASS proves Tally's handling of that decision, not the real model's choice. If the queue is empty, the stub answers with `ask_clarification`.
- The assistant capitalizes descriptions (`verify jeepney` is saved as `Verify jeepney`). Match DB rows case-insensitively.
- The conversation persists across page loads. Filter cards by the nonce, not by position.
- Changing the provider URL, model, or disclosure invalidates consent. Every relaunch gets a new stub port, but each run uses a fresh DB, so opt in again on each run anyway.
- Local repayment guards (negation, uncertainty, payer mismatch, overpayment, multiple names) run after the provider call and can override the queued tool. That's intended. Assert the guard's outcome.
