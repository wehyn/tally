# Contributing to Tally

## Start here

Before changing the project, read:

1. `AGENTS.md` for repository-specific instructions.
2. `CONTEXT.md` for product language and domain rules.
3. Any related architecture decision records in `docs/adr/`.

## Scope and implementation

- Keep a change within the issue's stated outcome and acceptance criteria. Raise conflicts or missing product decisions before encoding assumptions.
- Preserve the privacy boundaries and accounting rules in `CONTEXT.md` across screens, server actions, APIs, analytics, and assistant tools.
- Keep personal finance records scoped to their owner. An administrator manages access and instance settings, but does not gain access to personal financial data or assistant conversations.
- Keep SQLite data in the documented persistent runtime location. Document the app's runtime needs while leaving Docker Compose and network exposure under the home-server owner's control.
- Do not add a third-party finance integration, hosted AI call, or other external data flow without an issue that defines its purpose and privacy behavior.

## Verification

- Run the checks configured by the project that cover the changed behavior, and report the commands and outcomes in the pull request.
- For finance changes, verify user-visible balances and summaries as well as record ownership. Opening balances, transfers, and shared-goal contributions have distinct accounting behavior; see `CONTEXT.md`.
- For assistant changes, use a deterministic provider substitute where possible. Do not make verification depend on a live Codex-LB response.
- If the repository does not yet provide a relevant check, say so and describe what was reviewed manually. Do not claim a check passed if it was not run.

## Pull requests

Link the issue being addressed. Describe the user-visible change, relevant privacy or accounting effects, and verification performed. Include screenshots for meaningful UI changes, using synthetic data rather than personal finance information.
