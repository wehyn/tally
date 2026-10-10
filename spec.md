# Tally v1 Product Specification

- **Status:** Product scope for v1
- **Date:** 2026-10-08
- **Domain reference:** [CONTEXT.md](CONTEXT.md)

## Purpose

Tally is a self-hosted finance tracker for people who share a home-server instance. Each person needs a private ledger for their own money, a quick way to record activity, a private register of debts, and factual views of their finances. People may also collaborate on savings goals without sharing their personal accounts or transactions.

V1 delivers private personal finance and debt tracking, an optional hosted assistant for capture and questions, shared savings goals, and a recoverable single-server deployment.

## Goals

- Let anyone who can reach the instance register and keep a private ledger.
- Give the first registrant instance-administration privileges without exposing personal finance data to the admin role.
- Track PHP cash and bank accounts, opening balances, income, expenses, and transfers.
- Track current amounts owed to the user and amounts the user owes, without mixing debt records into the account ledger or analytics.
- Show current balances and actual activity, defaulting analytics to month-to-date.
- Offer opt-in natural-language transaction capture and factual finance questions through Codex-LB.
- Let users collaborate on goals and contributions without linking goals to personal transaction records.
- Run as one Next.js application with SQLite in persistent Docker-mounted storage, with nightly backups and a documented restore path.

## Actors and privacy boundaries

- **User:** Registers with a unique username and password. Owns private financial accounts, transactions, categories, debt records, and assistant conversations.
- **Admin:** The first registered user. Can manage instance settings and user access. Admin privileges do not grant access to another user's financial accounts, balances, transactions, categories, debt records, goals, or assistant conversations.
- **Goal member:** A user who has accepted an invitation. Can see the shared goal and its member contribution history, but not members' personal finance records.
- **Host operator:** Controls the home server and can access its files, including SQLite data and backups. The in-app privacy boundary does not protect data from a person with direct host-file access.

Every personal-data operation must be scoped to the signed-in owner on the server. Client-side hiding alone is not an authorization boundary.

## Product scope

### 1. Registration, sign-in, and administration

- Registration is open to any person who can reach the instance.
- Users register and sign in with a unique username and password. Passwords must be stored using a secure password-hashing scheme.
- The first account becomes admin. The initial admin claim must be atomic so simultaneous registrations cannot create multiple admins. Later registrations receive regular-user access.
- Signed-in pages and actions require authentication. Users can sign out.
- The admin can see user access status, disable or re-enable access, manage instance settings, and issue a one-time password reset.
- A reset credential can be consumed once and requires the user to choose a new password. The admin never learns the user's new password.
- Admin controls and server actions must not return personal finance records or assistant conversations.

### 2. Personal accounts, ledger, and debt register

- A user can create cash and bank accounts with a name and PHP opening balance. A new account defaults to ₱0.
- The opening balance establishes the starting balance without creating a transaction or counting as income.
- The user's first account becomes the default account for assistant capture. The user can change the default later. At least one financial account is required before recording a transaction.
- V1 supports PHP only. Store and calculate money using precise minor-unit arithmetic; do not use floating-point arithmetic for financial totals.
- Income adds money to one owned account. Expenses subtract money from one owned account. Both appear in account history and relevant analytics.
- Transfers move money between two accounts owned by the same user. Update both account balances as one operation. Show the transfer in account history, but exclude it from income and spending totals.
- Users can manually create, view, edit, and delete their own income, expense, and transfer records. Income and expense records have an amount, date, account, category, and optional description. The selected category determines whether a record is income or expense. Transfers identify source and destination accounts and are managed from Accounts.
- Seed every user with income categories **Salary** and **Other income**, and expense categories **Food**, **Transport**, **Housing**, **Utilities**, **Health**, **Shopping**, **Education**, **Entertainment**, **Travel**, and **Other**. Users can add, rename, and choose icons for categories in **Transactions → Manage categories**.
- A user can privately track current debts in two directions: **owed to you** and **you owe**. Each record has a counterparty, positive PHP amount, optional due date and note, and open or settled status. Users can create, edit, settle, reopen, and delete only their own records.
- Debt amounts are maintained manually as current outstanding amounts; v1 has no repayment schedule or debt payment history. A real receipt or repayment must be recorded separately in Transactions, and the debt amount/status updated by the user.
- Debt records do not create or change financial accounts, transactions, balances, income, spending, or dashboard analytics. They remain a private register separate from the personal ledger.
- Accounts, categories, transactions, and debt records are private to their owner, including when another user is the admin.

### 3. Dashboard and analytics

The dashboard is the signed-in user's overview and shows:

- Four summary cards: total balance across all accounts, plus income, spending, and net activity for the selected period.
- An Assets section with the positive-balance total and each account's current balance and proportional weight. Zero and negative balances remain visible but are excluded from the asset total and weights.
- Recent transactions with category icons and active shared goals.
- The date range represented by period-based figures.
- Category management is in **Transactions → Manage categories**; the dashboard has no spending-by-category panel or separate quick-entry form.

Use Asia/Manila for relative dates, the current day, and month boundaries. Opening balances affect current balances but are not income. Transfers affect account balances but are not income or spending. All dashboard figures must use only the signed-in user's personal records, except that shared-goal progress is visible to that goal's members.

### 4. Optional in-app assistant

#### Opt-in and data handling

- The assistant is optional. Before the first hosted request, the user must opt in after being told that prompts and the minimum relevant finance data will be processed through the hosted Codex-LB API.
- The disclosure must describe the actual configured provider path and its known retention/logging behavior. Confirm that behavior before presenting the opt-in.
- Call Codex-LB from the server. Keep provider credentials server-side.
- The assistant receives typed, user-scoped actions and app-calculated finance results. It does not get direct database access or authority to read another user's data.
- Send only the user's prompt and the minimum contextual data needed for the requested action or answer.

#### Transaction capture

- Provide manual transaction entry in Transactions and an assistant chat UI; do not add a separate dashboard quick-entry form.
- For a complete income or expense prompt, such as “Jollibee lunch 250,” save the transaction immediately without a separate confirmation step. A category determines whether the record is income or expense, and a description is optional.
- Use the user's default account when none is named, and use a best-guess category when none is named. The user can edit the category on the result card or later.
- Respect an explicitly named account and date. Interpret relative dates in Asia/Manila; when no date is specified, use today in that timezone.
- If required information cannot be inferred from the prompt or user settings, ask only for the missing information. Do not save an incomplete transaction.
- After saving, show a transaction card with amount, category, account, and date, plus a description when provided. Provide an approximately 10-second Undo action for that entry.
- Users can edit their own saved records after the Undo period. Deletion after the approximately 10-second assistant Undo window is permanent in the app. Manual entry remains available to users who do not opt in to AI.

#### Debt capture

- For a clear debt statement, such as “Mom owes me 3486” or “I owe Mom 3486,” create an open debt in the correct direction in the private debt register. Ask only when the counterparty, direction, or amount is unclear.
- Debt capture never creates a transaction or changes account balances or analytics. Respect an explicitly stated due date or note when provided.

#### Factual questions and conversation history

- Answer finance questions from the signed-in user's actual records. The application calculates totals and supplies the applicable date range; the assistant must not invent totals or present unsupported recommendations.
- Default analytics answers to month-to-date and state the date range. Use Asia/Manila for date interpretation and month boundaries.
- Save conversation history privately for its owner. The user can delete a conversation without deleting or changing finance records.

### 5. Shared savings goals

- A user can create a goal with a name, a required PHP target, and an optional deadline.
- The goal manager can edit the name, target, and deadline and manage invitations.
- The manager can invite a registered user by username. An invitee must accept before becoming a member.
- Only goal members can view a goal and its contribution history. Goal sharing exposes the target, combined progress, and each member's contribution amounts; it never exposes personal accounts or transactions.
- Members add contributions manually. Contributions are separate from personal transactions and do not affect financial account balances.
- Members can edit or delete only their own contributions. Contribution history remains in goal progress when a member leaves or is removed.
- Mark a goal complete automatically when total contributions reach its target. The manager can raise the target to continue the goal.
- If a user deletes their account, retain their contributions under the display name “Former member.” If a non-deleted member leaves or is removed, preserve their username in contribution history. When a manager leaves, is removed, or deletes their account, management passes to the first currently active accepted invitee; if none exists, archive the goal with its history preserved.

### 6. Account deletion

- A user can delete their own account.
- Deletion removes that user's private accounts, transactions, categories, debt records, and assistant conversations so they are no longer available in Tally to that user, other users, or the admin.
- Preserve shared-goal contribution records and progress. Show the deleted contributor as “Former member.” Preserve the goal for its remaining members and transfer management as described above.
- Deletion must not remove or expose another user's personal finance data.
- If the deleting user is the admin and other enabled users remain, require an explicit handoff of admin access to one of those users.

### 7. Deployment, persistent data, and recovery

- Build the application with Next.js and SQLite for a single app instance on the home server.
- Run it in Docker. Store the SQLite database and backup files in persistent host-mounted storage so container recreation does not erase data.
- The home-server owner configures Docker Compose and network exposure manually. Open registration applies to anyone who can reach the instance.
- Create SQLite backups nightly at 02:00 Asia/Manila on the same home server. Back up safely while the app is running, validate snapshots, and retain the latest 30 valid snapshots. Document the exact operator restore procedure. Warn clearly that restoring a pre-deletion snapshot can reintroduce private data deleted after that snapshot.
- V1 does not require an external backup service or a second-device backup.

## Out of scope for v1

- CLI or messaging integrations, including Hermes, iMessage, and Telegram.
- Receipt photo scanning or OCR.
- Recurring bill tracking and reminders, credit-card accounts, or budgets.
- Automated budget or savings recommendations.
- Local AI processing or multiple currencies.
- Bank synchronization; accounts and transactions are entered manually or through the in-app assistant.

## Acceptance criteria

V1 is acceptable when the following outcomes work for multiple independent users against one running instance:

1. **Account bootstrap:** A reachable person can register and sign in. Concurrent first registrations produce exactly one admin; subsequent users are regular users. The admin can manage access and issue a one-time reset without seeing a user's private data or new password.
2. **Ledger isolation:** Each user can create private accounts, categories, and records. A user or admin cannot read or change another user's personal finance records through the app.
3. **Accounting behavior:** Opening balances affect balances without appearing as transactions or income. Income and expenses change balances and analytics correctly. Transfers update two owned accounts together and never inflate income or spending totals.
4. **Dashboard:** The user sees total balance across all accounts; income, spending, and net activity for the selected period; positive-balance Assets with each account's balance and weight; recent transactions with category icons; and active goals. Category management is in Transactions. The dashboard has no spending-by-category panel or separate quick-entry form. Period totals state their Asia/Manila date range.
5. **Assistant capture:** A user who opts in can save a complete natural-language income or expense using the default account and a best-guess category, with the category determining the transaction type and no required description. They can see the saved fields, undo the entry promptly, and later edit or delete it. Clear debt statements create an open record in the correct debt direction and never create a transaction or change ledger figures. An incomplete entry is not saved until required information is supplied. Users who do not opt in can maintain their ledger manually.
6. **Assistant privacy and answers:** Hosted processing happens only after opt-in, with the configured provider path disclosed. Questions use only the signed-in user's records, provide a date range, and do not invent totals. Conversation deletion leaves finance records intact.
7. **Shared goals:** A user can create a goal, invite another registered user, and require acceptance. Members can see goal progress and contributions, add their own contribution, and edit or delete only their own entries. Contributions do not alter personal balances.
8. **Deletion:** Account deletion removes private finance and chat data while preserving goal contributions under “Former member” and preserving group progress. Goal management passes to the next invited user when its manager deletes their account.
9. **Recovery:** Recreating the app container preserves the SQLite database. Nightly backups are stored persistently, and a documented restore recovers personal ledgers, transfers, goals, contributions, assistant history, and former-member goal history.
10. **Debt register:** A user can see separate “Owed to you” and “You owe” lists, maintain current amounts and optional due dates/notes, filter outstanding and settled records, and settle or reopen their own debts. Another user, including the admin, cannot access those records. Creating or editing a debt does not change accounts, transactions, balances, income, spending, or analytics; repayments are entered separately as transactions.

## Verification approach

Use browser end-to-end tests against the running Next.js application with an isolated SQLite database and a deterministic fake Codex-LB endpoint. Tests should observe user-visible outcomes and authorization boundaries rather than internal helper names or database implementation details.

Use multiple users to exercise registration and admin bootstrap, private ledgers and debt registers, admin access boundaries, manual entry, assistant opt-in and capture, date-range analytics, transfers, goal invitations and contributions, account deletion, and backup/restore. Verify accounting invariants through visible balances and analytics; specifically confirm debt records never affect ledger figures and repayment transactions remain independently recorded.

## Open product and implementation details

- Select and document the exact starter category list.
- Confirm and accurately describe Codex-LB's retention and logging behavior for the configured upstream before collecting opt-in.
- Recommendations remain deferred until usage history exists; any later threshold or criteria require a separate decision.
