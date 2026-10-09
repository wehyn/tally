# Tally domain context

Tally is a self-hosted personal finance tracker for people using the same home-server instance. This document defines the product's domain terms and rules for v1. Architectural choices belong in `docs/adr/`.

## People and privacy

- A **user** is one person with a private ledger and assistant history. Registration is open to anyone who can reach the instance.
- The first registered user becomes the **admin**. Registration must establish this role atomically so simultaneous first registrations cannot create multiple admins.
- The **admin** manages instance settings and user access, including disabling or re-enabling accounts and issuing a one-time password reset that the user must consume to choose a new password. Admin status does not grant access to a user's financial accounts, transactions, categories, goals, or assistant conversations.
- Personal finance records and assistant conversations are private to their owner. Sharing a goal exposes that goal and its member contribution history only.
- Users may delete their own account and private data. Shared-goal contributions remain in the goal history under **Former member**. If the deleted user created a goal, management passes to the first currently active accepted invitee; if none exists, the goal is archived with its history preserved. An admin who deletes their account while other enabled users remain must explicitly hand off admin access to one of them.

## Money and dates

- V1 uses Philippine pesos (PHP) only. Store and calculate amounts precisely; display them with the peso sign (₱).
- Interpret relative dates and month boundaries in **Asia/Manila**. An omitted transaction date means today in that timezone.
- A **financial account** is a user's tracked place for money, such as cash or a bank account. It is separate from the user's sign-in account.
- A new financial account has an opening balance of ₱0 by default. Users may set or change that balance without creating a transaction. The opening balance affects the current balance, but is not income.
- A user's first financial account becomes the default account. The user can change that default later. At least one financial account is required before logging a transaction.

## Ledger records

- An **income** adds to one financial account and counts as income.
- An **expense** subtracts from one financial account and counts as spending.
- A **transfer** moves money between two financial accounts owned by the same user. It updates both balances together, appears in account history, and is excluded from income and spending totals.
- Income and expense records belong to one user and include an amount, date, financial account, category, and optional description. Transfers have a source account, destination account, amount, date, and optional description. The selected category determines whether a record is income or expense; transfers are managed from Accounts.
- New users receive these starter categories: income **Salary**, **Other income**; expenses **Food**, **Transport**, **Housing**, **Utilities**, **Health**, **Shopping**, **Education**, **Entertainment**, **Travel**, **Other**. Users may add or rename categories for their own ledger.
- Users may edit or permanently delete their own transactions at any time. Assistant Undo is a separate ten-second action; after it expires, deleting a transaction has no recovery path in the app.
- Dashboard and assistant totals describe recorded actuals for a clear date range. The dashboard starts with month-to-date. Recommendations are deferred until enough history exists to support them; the threshold is not yet defined.

## In-app assistant

- The assistant is optional and uses the hosted Codex-LB API only after the user opts in. Explain what prompts and finance data are sent, and send only the minimum relevant data. Provider credentials stay on the server. Assistant actions must use app-calculated data and user-scoped operations, not direct database access.
- For a complete prompt such as “Jollibee lunch 250,” save the transaction immediately, then show what was saved: amount, category, financial account, and date, plus the description when provided. Infer income or expense from the category and never ask the user to choose a type when the category is clear. Use the user's default account unless the prompt names another account. Use a best-guess category when omitted, and let the user correct it.
- Ask only for information needed to save a complete record that cannot be inferred from the prompt or user settings. A short Undo action is available after assistant logging; the owner can also edit or delete the transaction later.
- Answer finance questions from the owner's recorded actuals and state the applicable date range. Do not invent totals or present unsupported recommendations.
- Assistant conversation history is private to its owner and can be deleted separately from finance records.

## Shared goals

- A **shared goal** has a PHP target, an optional deadline, and an explicit membership list. The goal manager invites a registered user; the invitee must accept before joining. When a manager leaves, is removed, or deletes their account, management passes to the first currently active accepted invitee; if no accepted invitee remains, the goal is archived and its history is preserved.
- A **contribution** is a manual goal record attributed to a member. It is separate from personal transactions and does not change any financial account balance.
- Members can see combined progress and how much each member contributed. A member may edit or delete only their own contributions. Past contributions remain in goal history when membership ends and retain that member's username. Account deletion changes only that user's contribution display name to exactly **Former member**.
- A goal reaches its completed state when contributions meet its target. Its manager can raise the target to continue it.

## Runtime and v1 boundaries

- The application uses Next.js and SQLite and is intended to run as a single app instance in Docker on a home server. SQLite data must live in persistent mounted storage. The operator configures Docker Compose and network exposure manually.
- Create SQLite backups nightly at 02:00 Asia/Manila on the same home server and retain the latest 30 valid snapshots. A restore may reintroduce private data deleted after the selected snapshot; show a clear warning before replacing the live database. V1 does not require an external backup service.
- V1 includes manual ledger entry, the in-app assistant, actuals-focused analytics, and shared goals.
- CLI and Hermes messaging integrations, receipt scanning/OCR, bill tracking, credit-card accounts, budgets, local AI processing, multiple currencies, and automated recommendations are outside the initial release.
