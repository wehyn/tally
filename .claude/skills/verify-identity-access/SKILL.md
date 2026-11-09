---
name: verify-identity-access
description: Model-check Tally's sign-in, admin, reset-credential, Shortcut-credential and account-deletion rules (TLA+). Use when a change touches registerUser, setUserEnabled, setResetCredential, consumeResetCredential, the Shortcut credential functions, deleteAccountOwner, src/lib/auth.ts, or the auth, admin, account, settings/shortcut-credential and shortcuts/assistant routes.
---

# Verify identity and access

## What is promised, and the harm if it breaks

- **There is always an admin while enabled users exist.** Harm: nobody can disable users or issue resets. (`AdminWhileEnabledUsers`, `AtMostOneAdmin`, `AdminIsEnabled`)
- **A disabled or deleted user cannot get in**, by browser session or by Shortcut credential. Harm: an account the admin shut off keeps reading and writing finance data. (`AccessNeedsEnabledUser`, `DeletedLeavesNothing`)
- **A reset credential works once, and not for a disabled user.** Harm: a leaked reset code takes over an account twice. (`ResetSingleUse`)

The model also holds three rules the current code **breaks** (see "Known findings").

## Coverage record

Last confirmed to describe the code at commit **c006c65**.

| Model action | Code |
|---|---|
| Register | `registerUser` in `src/lib/store.ts`; `src/app/api/auth/register/route.ts` |
| Login, Logout, UseSession | `src/app/api/auth/login/route.ts`, `logout/route.ts`; `currentUser` in `src/lib/auth.ts` |
| Disable, Enable | `setUserEnabled` in `store.ts`; `src/app/api/admin/users/route.ts` |
| IssueReset, Expire, ConsumeReset | `setResetCredential`, `consumeResetCredential` in `store.ts`; `src/app/api/admin/users/[id]/reset/route.ts`; `src/app/api/auth/reset/route.ts` |
| SetCred, ClearCred, UseShortcut | `setShortcutCredentialHash`, `findEnabledUserByShortcutCredentialHash` in `store.ts`; `src/app/api/settings/shortcut-credential/route.ts`; `src/lib/shortcut-credential.ts`; `src/app/api/shortcuts/assistant/route.ts` |
| DeleteAccount | `deleteAccountOwner` in `store.ts`; `src/app/api/account/route.ts` |

Indivisible steps: each store function is one SQLite transaction or one UPDATE, so each is one model action. Route-level checks (same-origin, rate limits, bcrypt) are not modeled.

To see whether the covered code changed since the sync commit: `git diff c006c65 -- src/lib/store.ts src/lib/auth.ts src/lib/shortcut-credential.ts src/app/api/auth src/app/api/admin src/app/api/account src/app/api/settings/shortcut-credential src/app/api/shortcuts`. Move the sync commit above forward only after you have confirmed the model still matches the code at the new commit.

## Run it

From the repo root, in this order:

1. `sh .claude/skills/verify-identity-access/model/code-guards.sh` — checks that every guard the model relies on still exists in the code. A line starting `MISSING` names the guard and the model rule it protects. Seconds, no install.
2. Run the pstack `/statechart` skill on `model/IdentityAccess.tla` with config `model/IdentityAccess.cfg` and view `model/view.ts`, writing to a new scratch folder outside the repo. About 15,000 states, about 10 seconds after the first install.

Expected result today: these rules **hold**: `TypeOK, AtMostOneAdmin, AdminIsEnabled, AdminWhileEnabledUsers, AccessNeedsEnabledUser, ResetSingleUse, DeletedLeavesNothing, NoDeadlock`; these **break** (findings): `ResetEndsOldSessions, ResetEndsOldShortcuts, ResetNotRevivedByEnable`. Any other rule breaking, or a finding no longer breaking, needs your attention.

## Known findings (the model matches the code; the code breaks these rules)

Do not weaken the rules to make them pass. Do not change product code unless the user asks.

1. **`ResetEndsOldSessions`** — Alice signs in. The admin issues her a reset code. She uses it to choose a new password. Her old browser session is still signed in, for up to 7 days (`TTL_SECONDS` in `auth.ts`); nothing in `consumeResetCredential` or `currentUser` ties a session to the password.
2. **`ResetEndsOldShortcuts`** — Alice creates a Shortcut credential, then resets her password. The credential still calls the assistant; `consumeResetCredential` leaves `shortcut_credential_hash` alone.
3. **`ResetNotRevivedByEnable`** — The admin issues Bob a reset code, disables Bob, then re-enables Bob within 15 minutes. The old code works again; `setUserEnabled` does not clear `reset_token_hash`.

Also true of the code, not a rule violation: if the only admin deletes their account while every other user is disabled, no admin remains (the handoff rule only applies to *enabled* users), and the next person to register becomes admin (`registerUser` picks admin when no admin row exists). The two-person flow chart shows it.

## When a check fails

- `MISSING` from `code-guards.sh`: the code changed on purpose or by mistake. Open the file, decide which. If intended, update the matching action in `IdentityAccess.tla`, update `code-guards.sh`, and re-run.
- A "holds" rule breaks in `/statechart`: read its path. Replay it against the real code (a store call per step, as in `tests/store.test.ts`). If the code really does that, it is a bug: report it with the path in plain words. If the code does not, the model is wrong; fix the model action, never the rule.
- Intended behaviour change (for example, revoking sessions on reset): change the action in `IdentityAccess.tla`, move the rule from "break" to "hold" here, and update the doc `docs/state-machines/identity-access.md`.

## Files

- `model/IdentityAccess.tla` — the model. Two people, `Users` is a constant (`UsersTwo`, `UsersOne`).
- `model/IdentityAccess.cfg` — the full check with the findings. `model/FlowSession.cfg`, `model/FlowAdmin.cfg` — rules that hold, for the two flow charts.
- `model/view.ts`, `model/view-flow-session.ts`, `model/view-flow-admin.ts` — the words on the charts.
- `model/code-guards.sh` — structural conformance check.
- `docs/state-machines/identity-access.md` — inventory and charts.

## What is not covered

Two users only; at most one outstanding reset code per user; time is one step (a code is live or expired). Not modeled: password verification, rate limits, same-origin checks, JWT signature and expiry, goal and debt side effects of deleting an account (see the goals skill), other tables. A pass says the model holds under those bounds, and `code-guards.sh` says the listed guards still exist. It does not prove the code equals the model.
