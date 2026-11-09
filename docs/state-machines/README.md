# Tally state machines

Verified at commit `c006c65`. Each subsystem has a TLA+ model and a project skill under `.claude/skills/verify-<name>/`, and a doc here with the inventory, the user-flow statecharts, and the findings.

| Subsystem | Doc | Skill | Result |
|---|---|---|---|
| Identity and access | [identity-access.md](identity-access.md) | `verify-identity-access` | 3 rule breaks |
| Shared goals | [goals.md](goals.md) | `verify-goals` | 2 rule breaks |
| Debts | [debts.md](debts.md) | `verify-debts` | 1 inconsistency |
| Bills | [bills.md](bills.md) | `verify-bills` | 1 rule break (product call) |
| Assistant | [assistant.md](assistant.md) | `verify-assistant` | 4 rule breaks |
| Ledger | [ledger.md](ledger.md) | `verify-ledger` | none |

Not modeled: client-side React state (assistant widget, confirm dialog, popovers).
