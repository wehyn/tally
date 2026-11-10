# Tally state machines

Each subsystem has an explicit pure machine in `src/lib/machines/`, a TLA+ model and verify skill in `.claude/skills/verify-<name>/`, and a doc here with the inventory, the user-flow statecharts, and the findings. Charts are in `charts/` (open `charts/tabs.html`).

| Subsystem | Machine | Doc | Skill | Result |
|---|---|---|---|---|
| Identity and access | `machines/identity.ts` | [identity-access.md](identity-access.md) | `verify-identity-access` | 3 rule breaks, fixed |
| Shared goals | `machines/goal.ts` | [goals.md](goals.md) | `verify-goals` | 3 rule breaks, fixed (plus 1 found while fixing; product call: disabling never archives a goal) |
| Debts | `machines/debt.ts` | [debts.md](debts.md) | `verify-debts` | 1 inconsistency, fixed |
| Bills | `machines/bill.ts` | [bills.md](bills.md) | `verify-bills` | 1 rule break, fixed (product call: refuse the edit) |
| Assistant | `machines/assistant.ts` | [assistant.md](assistant.md) | `verify-assistant` | 6 rule breaks, fixed (product call: a pending question ends only by an exact cancel, an answer that resolves it or a completed write, and a read-only answer leaves it pending) |
| Ledger | none | [ledger.md](ledger.md) | `verify-ledger` | none, rule already enforced in code |

Open product calls: a sole admin deleting their account while every other user is disabled; disabling a user does not end their sessions or Shortcut credential; bills posted before `last_posted_due_date` existed are not protected until their next post.

Not modeled: client-side React state (assistant widget, confirm dialog, popovers).
