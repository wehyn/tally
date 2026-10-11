## Delegation

- Use subagents only for two or more independent, bounded workstreams.
- Keep the main agent responsible for planning, integration, and final verification.
- Give each subagent a specific deliverable and non-overlapping file ownership.
- Do not delegate small, sequential, or tightly coupled changes.
- Prefer parallel research, exploration, testing, and review over parallel edits.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Assistant debt repayments

- Keep a received repayment as one owner-scoped `recordDebtPayment` store operation: it records income and reduces an open `owed_to_you` debt atomically. Validate the debt, amount, account, and income category before either write can persist.
- Keep counterparty names out of the provider system prompt. Send only JSON-escaped counterparty and formatted amount as untrusted context; match normalized names to the oldest open debt, and ask before writing when no debt matches or the payment exceeds that balance.
- Do not offer generic transaction Undo for a repayment; it cannot restore the debt. Cover provider context, route behavior, and storage rollback in `tests/provider.test.ts`, `tests/assistant-route.test.ts`, and `tests/debts.test.ts`.
