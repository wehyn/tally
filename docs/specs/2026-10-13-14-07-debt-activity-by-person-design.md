# Debt Tracking, Explicit Transactions, and Activity by Person

- **Status:** Draft for owner review
- **Date:** 2026-10-13
- **Scope:** Capture debts naturally, record linked money movements only when requested, settle repayments in either direction, and show activity grouped by counterparty.

## Problem

Debt statements and actual money movements are related, but they are not the same action. A debt should be tracked when the user says someone owes them or they owe someone. An account transaction should be added only when the user asks to record the money movement. When a transaction is requested, it must link to the right debt so later payments reduce that debt and remain visible under the same person.

The assistant also has four matching risks: a due date can be mistaken for the advance date; a stale provider choice can override a newer account or category clarification; and the provider can select a different debt direction or counterparty than the user stated.

## Goals

- Record an assistant-created debt without changing account balances by default.
- When the user explicitly asks to add a new debt's money movement to Transactions, record one linked expense for `owed_to_you` or linked income for `you_owe` atomically with the new debt.
- Allow the user to opt into a transaction in a later active follow-up without creating a duplicate debt.
- Record money received toward an open `owed_to_you` debt as linked income, and money paid toward an open `you_owe` debt as linked expense. Reduce the matching debt atomically.
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

Add a nullable `transactions.debt_id` reference to `debts(id)` with `ON DELETE SET NULL`. An `owed_to_you` advance is an expense and its repayments are income; a `you_owe` borrowing is income and its repayments are expenses. Existing rows receive `NULL`; do not infer relationships from names, descriptions, dates, or amounts. Store operations enforce that a debt has at most one linked advance while allowing multiple repayments.

The store owns both write paths:

- `recordDebtAdvance` validates the direction-matching positive transaction amount, account ownership, and category ownership before commit. It creates the debt and linked expense or income atomically, marks the transaction as assistant-created, and leaves Undo unavailable.
- `recordDebtAdvanceTransaction` links an explicitly requested advance to an existing open debt in the active conversation without creating another debt or a second advance.
- `recordDebtPayment` remains one owner-scoped operation. It validates an open `owed_to_you` debt, amount, account, and income category before either write can persist, then links the income transaction to that debt and reduces the open balance atomically. A payment above the outstanding amount is rejected. A fully paid debt becomes `settled` and retains its last positive balance for display; status is authoritative.
- `recordDebtRepayment` records an expense and reduces an open `you_owe` debt atomically, with the same ownership, amount, account, category, settlement, and no-Undo protections.

Linked expense and repayment transactions cannot be deleted or have their amount or kind changed while the debt exists. A linked debt cannot change direction. Category, account, date, description, and outstanding debt amount can still be edited; changing these does not rewrite the historical amount moved. Deleting a debt preserves its linked transactions as normal ledger history and clears their links, after which the transactions can be edited or deleted independently.

### Assistant behavior

- Include a `recordTransaction` boolean in the `log_debt` tool. It defaults to `false`; only clear user wording can opt in. The server enforces the user's choice even if the provider selects another tool or disagrees.
- A plain debt statement creates only the debt. Tell the user they can ask to add the related money movement; if they opt in during that active follow-up, attach it to the same debt.
- If the user explicitly asks to record the movement, map `owed_to_you` to expense and `you_owe` to income. Purpose, description, and category are optional; infer a useful description/category when possible and otherwise use the matching fallback category. If the user explicitly names an invalid account or category, ask before writing.
- Use an explicitly named account/category and the latest clear user clarification. Otherwise use the default account and matching fallback category. If required account or category setup is missing while a transaction is requested, ask before writing either record.
- Use a transaction date stated for the movement; otherwise use today. Due, payable-by, and repayable-by dates remain debt dates and never become transaction dates by themselves.
- If the provider selects a different direction or a counterparty not named in the active user context, ask for clarification without writing. If explicit user wording contradicts provider direction, ask rather than creating the wrong balance movement.
- For incoming repayments, preserve exact payer matching and the oldest-open-debt behavior. Ask without writing when wording is uncertain or negated, no debt matches, multiple counterparties are named, the provider selects a different payer, or the payment exceeds the balance.
- For an outgoing payment, match the named payee to an open `you_owe` debt and reduce it when one matches. If none matches, record the completed payment as an ordinary expense without changing any debt.

### Debt activity view

Within each direction section, group debt rows by trimmed, case-insensitive counterparty. A person group shows its total open amount and record count. Each debt stays a separate item so multiple obligations to the same person remain distinct. Its activity lists the linked advance expense and repayments from oldest to newest, including date, category, and signed amount. Settled items use the existing last-outstanding-balance label and do not contribute to the group's open total.

Manual debts, explicit debt-only assistant entries, and pre-migration debts with no linked transactions remain visible in their person's group and show that they have no linked transaction history. The Debts page loads this activity through the existing debt read path. When the assistant creates a debt or records a repayment, the existing debt-update event refreshes the grouped activity; ledger updates continue through the existing ledger event.

### Failure handling and compatibility

- A failed account/category/direction/debt validation or ledger-total check rolls back both the advance debt and expense.
- A failed repayment validation rolls back both the income transaction and debt change.
- Foreign-key deletion behavior preserves ledger entries if a debt record is removed.
- The database migration leaves all existing transaction links `NULL`. No historical data is changed or deleted.
- No new dependency is required. Keep the existing responsive Tally styles and category/account controls.

## Acceptance criteria

1. Saying “Mom owes me 500” creates an open debt only; the account balance and transaction list do not change.
2. Saying “Mom owes me 500 for Jollibee; add it to Transactions” creates one linked ₱500 Food expense and the debt atomically. The account decreases by ₱500 and no Undo is offered.
3. Saying “I owe Ate Liyah 100” creates a debt only. Asking to add it to Transactions records linked income because borrowed money entered the user's account; purpose and category are optional.
4. A clear “keep it debt-only” choice creates no transaction. The user can opt into a transaction later in the active follow-up without creating a second debt.
5. Missing account/category setup when a transaction is requested creates neither the debt nor the transaction. An invalid explicit account/category choice prompts for a valid choice.
6. Saying “Mom paid me 250” on a ₱500 open debt creates linked ₱250 income and leaves ₱250 open. Another valid ₱250 settles it, retains the last positive balance for display, and leaves the account higher by each payment.
7. Saying “I paid Ate Liyah 100” on an open debt creates linked expense and reduces it. If there is no matching debt, the assistant records an ordinary expense and leaves debts unchanged.
8. Repayment matching uses the exact named payer/payee and oldest open debt in that direction. A near-name match such as “Ann” to “Ann-Marie” is rejected; uncertain incoming repayments, missing incoming matches, multiple counterparties, conflicting provider selections, and overpayments do not write.
9. The Debts page groups case-insensitive person names within each direction, keeps separate debts, preserves stored order for tied activity, labels actions accessibly, and retains each transaction's category.
10. Manual debt entries and legacy records remain visible without guessed transaction links. Deleting a debt preserves ledger history and clears its foreign-key link.
11. Due, payable-by, and repayable-by dates never become transaction dates by themselves. Newer explicit account/category choices win over older provider choices.

## Verification

- Add store tests for migration defaults, both advance/payment directions, rollback, and linked edit/delete rules.
- Add assistant route/provider tests for explicit transaction choice, both repayment directions, exact payer matching, due-date separation, latest account/category choices, provider bypasses, and no-write clarifications.
- Add Debts page tests for case-insensitive grouping, multiple debts per person, chronological payment history, categories, and settled display.
- Run the focused debt/store/provider/assistant/view tests, then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- Capture and inspect the Debts page in Orca's browser at desktop and narrow widths before opening the PR.
