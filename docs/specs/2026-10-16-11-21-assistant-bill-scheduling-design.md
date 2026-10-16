# Assistant Bill Scheduling Design

- **Status:** Draft for owner review
- **Date:** 2026-10-16
- **Scope:** Create and update finite recurring bills through the assistant while preserving the existing Bills scheduler and ledger behavior.

## Goal

Let a user track a recurring bill in natural language, including a finite end date. For example, a TikTok Shop bill for a VXE R1 Pro can begin today and end on a specified date in December. The assistant should gather missing details, save the schedule once it is complete, and summarize what it saved.

## Decisions

- A statement such as “I have a bill…” is intent to track it.
- The bill name is inferred from the merchant and item.
- The first due date is the schedule's start date. “Today” means the bill is due today and may create an expense immediately through the existing scheduler.
- Supported cadence remains weekly, monthly, or yearly. Ask when it is not stated.
- Ask for the amount when missing; never infer it from unrelated context.
- If an end date is stated as a month only, ask for the day. If a day is stated without a year, use the nearest upcoming date.
- Use the default account and infer an expense category. Ask when either cannot be resolved. On updates, preserve omitted account and category fields from the existing bill.
- Bundle all missing required details into one concise follow-up. Do not write until those details and any duplicate choice are clear.
- Save immediately when the request is complete, then summarize the saved schedule; do not add a confirmation step.
- Treat the end date as inclusive. After the final scheduled occurrence, archive the bill while retaining it in the Archived list.
- Match active bills by exact normalized full name (case and punctuation insensitive, preserving word order). If a match exists, ask whether to add another schedule or update the existing one. If multiple exact matches exist, ask which one to update.
- Updates change the future bill schedule only. Posted transactions remain unchanged.

## Design

### Bill data and schedule processing

Add a nullable `end_date` to the existing SQLite `bills` table and `Bill` model. The existing additive migration pattern adds the column without changing current rows; a `NULL` end date keeps a bill open-ended.

Add optional end-date validation and persistence to the existing bill create/update paths and API schemas. The Bills form displays and edits the end date. Existing bills without an end date continue to recur as they do now.

The due-bill processor posts occurrences whose scheduled dates are on or before both today and the inclusive end date. It advances each occurrence atomically with its expense as it does today. When advancing after an occurrence puts the next due date after `end_date`, it archives the bill in that same transaction without posting the next occurrence. An update that sets an end date before the current next due date archives the bill immediately and posts no further occurrence. A newly created schedule must have its first due date on or before its end date.

Past first due dates remain invalid, matching the current Bills contract; this feature does not backfill historical occurrences. A first due date of today continues to trigger the existing immediate processing behavior. If expense posting fails after a bill is saved, report that fact and retain the current retry behavior.

### Assistant actions

Add bill-specific create and update actions to the existing provider tool set. The assistant passes inferred name, amount, cadence, first due date, end date, and optional account/category. The application remains authoritative: validate dates and amounts, resolve owner-scoped account/category records, and use the existing store methods for writes.

Do not send the user's full bill list to the provider. After the provider proposes a bill name, check the current user's active bills locally using exact normalized-name matching. If a match exists, save nothing and ask whether to add another schedule or update an existing one. An update uses the matching bill and changes only fields supplied by the user; omitted fields retain their existing values. If multiple active bills have the exact normalized name, ask which one to update. A provider action cannot bypass these checks.

The assistant response confirms the bill name, amount, cadence, first due date, end date, account, and expense category. Bill scheduling does not offer generic transaction Undo because removing the schedule cannot reverse an already posted expense.

### Compatibility and failure handling

- Existing bills and their ledger history remain intact; old rows with `end_date = NULL` remain open-ended.
- All create and update operations remain owner-scoped and validate account ownership and expense-category type/ownership.
- Invalid, ambiguous, or incomplete requests ask for clarification without writing.
- Duplicate detection applies only to active bills. Archived bills do not block a new schedule.
- Existing recurring-bill cadence, anchoring, catch-up, and atomic posting behavior remain in place.
- No dependency or separate installment-plan subsystem is introduced.

## Acceptance criteria

1. A natural-language bill statement starts the create flow and extracts a useful merchant/item name.
2. Missing amount, cadence, or exact end day is requested in one concise follow-up. A month/day without a year resolves to the nearest upcoming date.
3. A complete schedule is saved without an extra confirmation, using the default account and inferred expense category when those are omitted.
4. A bill due today creates its scheduled expense immediately through the current processor; the assistant reports a posting failure without claiming the expense was recorded.
5. The end date is inclusive, no occurrence after it is posted, and the bill is archived after its final scheduled occurrence.
6. Existing bills without end dates continue recurring; migration leaves their schedule and transaction history unchanged.
7. An exact normalized active-name match blocks the initial write and asks whether to add another or update. Choosing update modifies the matching schedule only; historical transactions stay unchanged.
8. Multiple exact active-name matches require the user to identify which schedule to update. An archived same-name bill does not block creation.
9. Invalid amounts, dates, accounts, categories, and unresolved duplicate choices do not write a bill or expense.
10. The Bills page displays and edits end dates and continues to show ended bills in Archived.

## Verification

- Add store/scheduler tests for nullable migration defaults, date validation, inclusive final occurrences, skipped post-end occurrences, automatic archival, same-day posting, retry behavior, and unchanged open-ended schedules.
- Add API and Bills UI tests for end-date create/edit/display, owner scoping, and expense-category validation.
- Add provider and assistant-route tests for the bill tools, bundled missing-field follow-ups, date interpretation, immediate saves, exact duplicate matching, create-another/update choices, multiple matches, and no-write behavior on invalid input.
- Verify updates leave already-posted transactions unchanged and no generic Undo is returned for a bill schedule.
- Run focused tests, then the repository test suite, typecheck, lint, production build, and `git diff --check` during implementation.
