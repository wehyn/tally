# Receive a debt repayment through Ask Tally

## Sub-features

Provider consent, interpretation guards, active amount clarification, partial payment, settlement, and ledger display.

## How to get to it (user POV)

Create a financial account and an open debt owed to you. In `/settings`, read the provider disclosure, check the agreement, and enable **Enable hosted assistant**. Use **Open Tally assistant** from the app shell. `/assistant` redirects to the dashboard and is not a separate chat page.

## Driving it with Playwright

Run the lifecycle in `../SKILL.md`. The `drive` command uses only UI actions to set up and submit these requests:

| Request | Expected outcome |
| --- | --- |
| Maybe Mom paid me 100 | Clarify, no financial write |
| Mom did not pay me 100 | Clarify, no financial write |
| Nobody paid me 100 | Ask about ordinary income, no financial write |
| Mom and Ari paid me 100 | Ask which payer, no financial write |
| Mom paid me 1001 | Reject excess against oldest Mom balance, no financial write |
| Mom paid me 10 into Wallet | Stub proposes Ari; clarify mismatch, no financial write |
| Mom paid me | Ask for amount despite stub proposing 100 |
| 100 | Active follow-up saves a ₱100 repayment and leaves ₱900 open |
| Mom paid me 900 | Settles that debt, retaining ₱900 as its last outstanding balance |

Each independent rejection starts after a page reload. The amount follow-up stays in the same active chat. Screenshots and the trace capture submissions and visible outcomes. Readonly SQLite checks compare financial state before and after each rejection and confirm two repayment transactions and two linked payment rows. API readbacks prove cash and cash flow increase by ₱1000 with zero income or spending. The newer Mom debt and Ari debt remain unchanged.

## Gotchas

The local provider is a deterministic external-boundary stub. Its fixed proposals intentionally challenge server validation. Live model behavior remains unverified. This run does not exercise cancellation, ordinary-income acceptance, missing-account or date follow-ups, privacy consent invalidation, owner isolation, rollback injection, or concurrent requests. Use the existing focused unit suites for their covered contracts and report those results separately. Never weaken a failed assertion to claim a passing journey. A missing seed precondition is a failure.
