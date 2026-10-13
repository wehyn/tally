# Debt Advances and Activity by Person

- **Status:** Draft for owner review
- **Date:** 2026-10-13
- **Scope:** Record assistant-created advances as expenses, link debt movements, and show debt and payment activity grouped by counterparty.

## Problem

The current feature change records an expense with a new debt owed to the user, but it does not persist a relationship between them. Repayments can increase an account balance and reduce the debt, but the income transaction is not linked to the specific debt. Later edits or deletes can therefore leave the account balance and outstanding debt inconsistent. The Debts page shows current balances by direction but does not show the advance and repayments together under the person who owes them.

The assistant also has four matching risks: a due date can be mistaken for the advance date; a stale provider choice can override a newer account or category clarification; and the provider can select a different debt direction or counterparty than the user stated.

## Goals

- When the assistant records a new `owed_to_you` debt, record one equal expense from the selected account in the same atomic store operation.
- Record each repayment as linked income while reducing the exact open debt by the same amount in one atomic operation.
- Group debts by counterparty within the existing **Owed to you** and **You owe** sections. Show each debt separately under its person, with its advance and repayment transactions in date order and with their existing categories.
- Keep the user's latest explicit account and expense category choices authoritative through clarification turns.
- Keep debt due dates separate from the advance transaction date.
- Ask without writing when the provider's direction or counterparty conflicts with clear user wording, the statement is uncertain, or the correct debt cannot be identified.
- Preserve the current repayment safety rules, including payer matching, overpayment rejection, owner scoping, settled status, and no generic transaction Undo.

## Non-goals

- Automatically creating an account transaction for debts entered manually through the Add debt form. The automatic expense applies to assistant-recorded advances; manual debt entry remains a way to track an obligation without asserting that money moved.
- Guessing links for existing debts or transactions. Existing records lack a reliable relationship and remain available in their current lists.
- Automatically linking manually entered transactions to debts by matching their descriptions or counterparty names.
- Replacing expense or income categories with the counterparty name. A person's name is the activity group; each transaction keeps its own category, such as Food or Other income.
- A contact manager, split payments, new account or category settings, or changes to unrelated assistant actions.

## Design

### Debt and transaction relationship

Add a nullable `transactions.debt_id` reference to `debts(id)` with `ON DELETE SET NULL`. An owed-to-you advance has one linked expense transaction; repayments have one or more linked income transactions. A partial unique index prevents more than one linked expense for a debt. Existing rows receive `NULL`; do not infer relationships from names, descriptions, dates, or amounts.

The store owns both write paths:

- `recordDebtAdvance` validates the debt, matching positive expense amount, account ownership, and expense category ownership before commit. It creates the debt and linked expense atomically, marks the transaction as assistant-created, and leaves Undo unavailable.
- `recordDebtPayment` remains one owner-scoped operation. It validates an open `owed_to_you` debt, amount, account, and income category before either write can persist, then links the income transaction to that debt and reduces the open balance atomically. A payment above the outstanding amount is rejected. A fully paid debt becomes `settled` and retains its last positive balance for display; status is authoritative.

Linked expense and repayment transactions cannot be deleted or have their amount or kind changed while the debt exists. A linked debt cannot change direction. Category, account, date, description, and outstanding debt amount can still be edited; changing these does not rewrite the historical amount moved. Deleting a debt preserves its linked transactions as normal ledger history and clears their links, after which the transactions can be edited or deleted independently.

### Assistant behavior

- For a clear statement that another person owes the user, call `log_debt` only. Save one same-amount expense and one debt; do not create a duplicate transaction.
- For a debt the user owes, save only the debt.
- Use an explicitly named account/category and the latest clear user clarification. Otherwise use the default account and the existing expense fallback category. If required account or category setup is missing, ask before writing either record.
- Use a transaction date stated for the advance; otherwise use today. A due date is stored only as the debt due date and never becomes the expense date by itself.
- If the provider selects a different direction or a counterparty not named in the active user context, ask for clarification without writing. If explicit user wording contradicts provider direction, ask rather than creating the wrong balance movement.
- Preserve the exact normalized payer and oldest-open-debt behavior for repayments. A repayment with uncertain wording, no match, multiple named counterparties, a conflicting payer, or an excessive amount creates no transaction and changes no debt.

### Debt activity view

Within each direction section, group debt rows by trimmed, case-insensitive counterparty. A person group shows its total open amount and record count. Each debt stays a separate item so multiple obligations to the same person remain distinct. Its activity lists the linked advance expense and repayments from oldest to newest, including date, category, and signed amount. Settled items use the existing last-outstanding-balance label and do not contribute to the group's open total.

Manual debts and pre-migration debts with no linked transactions remain visible in their person's group and show that they have no linked transaction history yet. The Debts page loads this activity through the existing debt read path. When the assistant creates a debt or records a repayment, the existing debt-update event refreshes the grouped activity; ledger updates continue through the existing ledger event.

### Failure handling and compatibility

- A failed account/category/direction/debt validation or ledger-total check rolls back both the advance debt and expense.
- A failed repayment validation rolls back both the income transaction and debt change.
- Foreign-key deletion behavior preserves ledger entries if a debt record is removed.
- The database migration leaves all existing transaction links `NULL`. No historical data is changed or deleted.
- No new dependency is required. Keep the existing responsive Tally styles and category/account controls.

## Acceptance criteria

1. Saying “Mom owes me 500 for lunch” with a default account creates one open Mom debt and one linked ₱500 expense categorized as Food; the account decreases by ₱500 and no Undo is offered.
2. A missing account or invalid expense category creates neither the debt nor the transaction.
3. Saying “Mom paid me 250” on a ₱500 open debt creates one linked ₱250 income transaction and leaves ₱250 open. A second valid ₱250 payment settles the debt, retains the last positive balance for display, and leaves total account balance increased by ₱250 for each payment.
4. With multiple open debts for Mom, each repayment links to the exact debt selected by the existing oldest-open and note rules. Each debt displays only its own linked movements.
5. The Debts page groups case-insensitive Mom records under one person heading, keeps separate debt items, shows linked expenses and payments in date order, and preserves each movement's income/expense category.
6. Manual debt form entries and legacy records remain visible without automatically generated or guessed transaction links.
7. While a debt exists, its linked transaction cannot be deleted or changed in amount/kind, and the debt direction cannot be flipped. Deleting the debt preserves the transaction rows and clears their links.
8. A due date never becomes the expense date unless the user also gives it as the advance date; an omitted advance date uses today.
9. A newer explicit account/category clarification wins over an older provider choice. A conflicting provider direction or counterparty results in a clarification and no writes.
10. Existing repayment behavior remains owner-scoped and atomic, and settled status remains authoritative.

## Verification

- Add store tests for migration defaults, linked advance/payment writes, rollback, and linked edit/delete rules.
- Add assistant route/provider tests for due-date separation, latest account/category choices, direction/counterparty conflict, and no-write clarifications.
- Add Debts page tests for case-insensitive grouping, multiple debts per person, chronological payment history, categories, and settled display.
- Run the focused debt/store/provider/assistant/view tests, then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- Capture and inspect the Debts page in Orca's browser at desktop and narrow widths before opening the PR.
