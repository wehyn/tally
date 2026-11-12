---
name: verify-tally
description: Launch isolated Tally instances, drive the Ask Tally debt repayment flow through the real web UI, and retain browser and SQLite evidence. Use to verify repayment behavior or diagnose this local user journey.
---

# Verify Tally

Run from the repository root on Linux with Node.js 20.9 or newer. The primary interface is the Next.js web UI. HTTP readbacks and readonly SQLite queries verify its effects. Existing `npm run test:browser` drives a Vite component fixture, not the full app.

## Launch

1. Install dependencies with `npm ci`. Check native SQLite with `node -e 'new (require("better-sqlite3"))(":memory:").close()'`. If it fails, resolve the native dependency installation before continuing.
2. Install Chromium with `npx playwright install chromium` if the browser is missing.
3. Run `node .agents/skills/verify-tally/scripts/verify.mjs up`.
4. Copy the printed absolute `RUN` directory. Pass it as the last argument to every remaining command.

The helper copies the current app source into `<RUN>/app`, links the installed dependencies, and starts Next development mode with Webpack on a free loopback port. It starts a local Chat Completions stub on another free loopback port. It uses `<RUN>/data/tally.sqlite`, a synthetic session secret, and explicit local provider settings. It does not read `.env` into the copied app. It overrides inherited database paths and provider credentials.

Startup succeeds only after the owned supervisor, provider identity, health endpoint, and registration page respond. Tally migrates its empty database on access. Registration, financial setup, and consent happen through the browser journey. A fresh directory is required for each run. Next may stop once for its upgrade advisory. The helper retries that command once with the same build cache and records the advisory in `server.log`; it does not upgrade dependencies. The copied source is a snapshot; restart after source changes. Concurrent instances have separate source copies, builds, databases, ports, and browser contexts.

## Doctor

Run `node .agents/skills/verify-tally/scripts/verify.mjs doctor <RUN>`.

The check validates the supervisor command through Linux `/proc`, checkout HEAD, provider run identity, app health, registration HTML, and SQLite integrity when the database exists. Each HTTP request has a five-second timeout. It writes `doctor.json`. It does not mutate the app database. It cannot establish live model availability because this instance uses a local stub.

## Drive

Run `node .agents/skills/verify-tally/scripts/verify.mjs drive <RUN>` once on a fresh instance. This is the executable journey in [received repayments](features/received-repayments.md). The feature map also documents [registration](features/registration.md), [accounts](features/accounts.md), and [manual debts](features/debts.md), which the journey uses as prerequisites.

The script uses Playwright against the actual Next app. It registers an owner, creates Wallet and debts through forms, reads the provider disclosure, opts in, and submits messages with **Open Tally assistant**, the **Ask Tally anything…** placeholder, and **Send message**. It uses the normal app APIs only for readonly balance and dashboard readback. It never inserts seed records or calls store mutations directly.

The local provider deliberately proposes writes for uncertain and negated requests, missing amounts, unknown and ambiguous payers, overpayment, and a mismatched payer. Tally must reject those suggestions without financial writes. A missing-amount follow-up then records ₱100 against the oldest of two Mom debts. A further ₱900 settles that same debt. Ari's debt and the newer Mom debt must remain unchanged.

The existing focused suites cover provider context, route guards, ownership, and storage rollback in more depth:

```sh
npx vitest run tests/provider.test.ts tests/assistant-route.test.ts tests/debts.test.ts
```

## Evidence

`<RUN>` retains `actions.json`, `before.json`, `partial.json`, `after.json`, `accounts.json`, `dashboard.json`, `provider-calls.json`, `doctor.json`, `result.json`, `server.log`, screenshots before submission and after outcomes, and `trace.zip`. Inspect the trace with `npx playwright show-trace <RUN>/trace.zip`.

Only `result.json` with `status=PASS` proves the mapped journey completed. A launch or doctor pass alone is insufficient. The journey asserts visible answers, repayment cards, no generic Undo, the settled balance label, ledger entries, cash totals, income and spending exclusion, and saved debt and payment rows. Browser errors fail the journey. Failure retains a screenshot and trace.

The provider stub replaces only the production external HTTP boundary. This proves browser-to-server-to-storage behavior with controlled model proposals. It does not verify real model extraction, a deployed service, concurrency, or every transition in the [statechart](../../../docs/statecharts/ask-tally-repayment.md). The synthetic data and provider transcripts are local evidence. Do not run this helper against a personal or deployed database.

## Cleanup

Always run `node .agents/skills/verify-tally/scripts/verify.mjs down <RUN>`, including after a failed drive. Run it twice to check repeatability.

Cleanup requires the `ownership.json` marker written by `up` and validates any supervisor manifest against the run and helper paths. It refuses unowned directories. Owned startup failures without a supervisor manifest can still have their scratch files removed. Cleanup checks process ownership before signalling the recorded process group, verifies both ports stop responding, and removes only `<RUN>/app` and `<RUN>/data`. It preserves proof files and writes `cleanup.json`. Confirm `result.json` and `trace.zip` still exist after cleanup. Startup failures also attempt cleanup. Never kill processes by name.

## Helpers

The executable helper is `scripts/verify.mjs`. Commands are `up`, `doctor`, `drive`, and `down`. `serve` is an internal supervisor command. Run paths must be immediate children of the repository's ignored `.verification/` directory. The ESLint and TypeScript configurations exclude `.verification/` so checks do not scan the copied app or generated build files. No package script or runtime configuration change is required.

Use `/maintain-verification-skill` when routes, selectors, setup, or behavior change. Update the feature map and statechart together, then execute the lifecycle again.
