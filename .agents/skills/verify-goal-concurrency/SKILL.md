---
name: verify-goal-concurrency
description: Verify goal completion when changing contribution writes, target edits, goal lifecycle rules, or SQLite transaction boundaries.
---

# Verify goal concurrency

A live goal is completed exactly when persisted contributions meet its persisted target. A stale completion flag either blocks needed contributions or accepts contributions after completion.

## Run

From the repository root with its lockfile dependencies installed:

```sh
node .agents/skills/verify-goal-concurrency/check.mjs
```

Requires Node 22.18+ and `mise` on PATH. The checker installs Temurin Java 25 and the checksum-pinned tla2tools v1.7.4 release asset (which identifies itself as TLC 2.19). Existing installations are reused. Offline environments can set `JAVA` to a Java 11+ binary and `TLA2TOOLS` to that exact jar. The runner verifies the jar checksum. All model executions, state files and SQLite databases use temporary folders outside the repository. Replay databases are deleted; checker evidence stays at the printed path.

Exit 0 means both bounded TLC configurations and the real-store replay pass. **Current implementation exits 0:** both completion invariants hold in the stated bounds. Treat a tool failure as an incomplete check, regardless of invariant results. Read [REPORT.md](REPORT.md) for fixed results, historical counterexamples and the two-worker assumption.

Read every TLA+ result with **`/statechart`**. Read that skill's current installed instructions, then use its workflow on the copied spec, each configuration and the view from the evidence directory. It supplies shortest paths and checks remaining rules after the first violation. Keep its output outside the repo. The direct checker stops at the first violation in each configuration, so it alone does not establish the other rules hold.

## Confirm source correspondence

Last confirmed sync commit: `72d55f369ab9b5bf040a150c8661ec99bb4f0e3e`.

Verified `src/lib/store.ts` SHA-256: `dc59002eef8c73dcde28b8318ade5fa2d068f9c76a23f1b0be981ce4b81def16`. Both model and real-store replay were confirmed against this commit on 2026-11-12.

Compare changes since this commit in:

- `src/lib/store.ts`: `requireGoalMember`, `safeGoalTotal`, `addContribution`, `updateGoal`.
- `src/lib/lifecycle.ts`: `nextGoalStatus`.
- `src/lib/db.ts`: WAL database setup and per-process store singleton.
- `src/app/api/goals/[id]/route.ts` and `src/app/api/goals/[id]/contributions/route.ts`: entry points.

Use the action-to-code table in [REPORT.md](REPORT.md). Recheck read/write order, SQL predicates, and transaction scope before trusting the model. Ordinary reads outside a transaction can interleave across workers. Preserve the entire contribution `BEGIN IMMEDIATE` transaction as one action. Both goal edits and contribution creation now perform their goal/total reads and writes inside their own BEGIN IMMEDIATE transaction. Model each whole transaction as one action. Waiting for a writer lock has no persisted effect; lock acquisition failure has no write effect.

When source boundaries change, update the model and replay scheduler together. Replay the reported sequence against real SQLite before accepting a violation. A missed replay is a suspected modeling error. Move the sync commit forward only after confirming the mapping at the new commit. `/maintain-formal-verification-skill` can reconcile skipped updates.

## Prove the detector can fail

```sh
node .agents/skills/verify-goal-concurrency/check.mjs --self-test
```

This requires a clean current model and replay. It checks both operation orders for raising/lowering the target and sequential equality. Two real connections attempt the old interleavings: an immediate zero-timeout competing write must return SQLITE_BUSY, then succeeds after the first transaction ends. Zero timeout is a deterministic test setting; production retains its configured timeout.

Four scratch copies test detector sensitivity: restore the unlocked contribution preflight, remove the target-edit transaction, change lifecycle equality from `>=` to `>`, and complete unconditionally. Each must violate its intended completion invariant. The first two must also demonstrate that the competing write actually succeeded at the old race boundary. Scratch copies/databases are deleted, and all original cases pass again afterward. Product files are untouched by the self-test.

## Scope

Two operations on one initially active goal: one accepted member adds 100 minor units, and its authorized manager edits a target between 100 and 200 minor units. Two real WAL connections simulate independently scheduled workers. Initial balance is zero. All inputs are valid and other users, goals and data are stable. The goal read, validation, UUID generation, username read, insert, total read and conditional status update in `addContribution` all run within one IMMEDIATE transaction. `updateGoal` likewise reads the goal/total and writes target/status under one lock. The model keeps the conditional status UPDATE semantics; it does not split either transaction.

`CompletionSound` requires completed goals to meet target. `CompletionRecognized` requires goals at target to be completed. `TypeOK` checks the bounded money/status domain. No invariant is waived for a pending request, and no state/action constraint filters out a failure.

These safety checks cover all interleavings in the two small configurations. They do not verify arbitrary amounts, overflow, retries, duplicate requests, crash recovery, busy timeouts, fairness/liveness, archived goals, succession, membership revocation, deletes, contribution edits, authorization, assistant debts, or deployment topology. A single synchronous Node worker cannot execute the modeled interleaving; production exposure requires concurrent processes or threads sharing the same SQLite file.
