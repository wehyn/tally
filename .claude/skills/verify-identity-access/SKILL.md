---
name: verify-identity-access
description: Model-check Tally's sign-in, admin, reset-credential, Shortcut-credential and account-deletion rules (TLA+). Use when a change touches src/lib/machines/identity.ts, registerUser, setUserEnabled, setResetCredential, consumeResetCredential, saveAccountState, the Shortcut credential functions, deleteAccountOwner, src/lib/auth.ts, or the auth, admin, account, settings/shortcut-credential and shortcuts/assistant routes.
---

# Verify identity and access

## What is promised, and the harm if it breaks

- **There is always an admin while enabled users exist.** Harm: nobody can disable users or issue resets. (`AdminWhileEnabledUsers`, `AtMostOneAdmin`, `AdminIsEnabled`)
- **A disabled or deleted user cannot get in**, by browser session or by Shortcut credential. Harm: an account the admin shut off keeps reading and writing finance data. (`AccessNeedsEnabledUser`, `DeletedLeavesNothing`)
- **A reset credential works once, and not for a disabled user.** Harm: a leaked reset code takes over an account twice. (`ResetSingleUse`)
- **A password reset ends earlier sign-ins and the Shortcut credential, and re-enabling does not bring back a reset code.** Harm: a reset that the user does after a leak still leaves the attacker signed in or able to call the assistant. (`ResetEndsOldSessions`, `ResetEndsOldShortcuts`, `ResetNotRevivedByEnable`)

## Coverage record

Last confirmed to describe the code at commit **ea526d7**. The doc and skill commits that follow it do not change covered code.

| Model action | Code |
|---|---|
| Register | `registerUser` in `src/lib/store.ts` (role from `roleForRegistration`); `src/app/api/auth/register/route.ts` |
| Login, Logout, UseSession | `src/app/api/auth/login/route.ts`, `logout/route.ts`; `setSession` and `currentUser` in `src/lib/auth.ts` (session version check) |
| Disable, Enable | `setUserEnabled` in `store.ts` (`nextAccountState`); `src/app/api/admin/users/route.ts` |
| IssueReset, Expire, ConsumeReset | `setResetCredential`, `consumeResetCredential` in `store.ts`; `saveAccountState` writes the result; `src/app/api/admin/users/[id]/reset/route.ts`; `src/app/api/auth/reset/route.ts` |
| SetCred, ClearCred, UseShortcut | `setShortcutCredentialHash`, `findEnabledUserByShortcutCredentialHash` in `store.ts`; `src/app/api/settings/shortcut-credential/route.ts`; `src/lib/shortcut-credential.ts`; `src/app/api/shortcuts/assistant/route.ts` |
| DeleteAccount | `deleteAccountOwner` in `store.ts` (`deleteRefusal`); `src/app/api/account/route.ts` |

The pure rules are in `src/lib/machines/identity.ts`. The store reads the row, asks the machine for the next state, and writes it back. Indivisible steps: each store function is one SQLite transaction or one UPDATE, so each is one model action. Route-level checks (same-origin, rate limits, bcrypt) are not modeled.

To see whether the covered code changed since the sync commit: `git diff ea526d7 -- src/lib/machines/identity.ts src/lib/store.ts src/lib/auth.ts src/lib/shortcut-credential.ts src/app/api/auth src/app/api/admin src/app/api/account src/app/api/settings/shortcut-credential src/app/api/shortcuts`. Move the sync commit above forward only after you have confirmed the model still matches the code at the new commit.

## Run it

From the repo root, in this order:

1. `sh .claude/skills/verify-identity-access/model/code-guards.sh` — checks that every guard the model relies on still exists in the code. A line starting `MISSING` names the guard and the model rule it protects. Seconds, no install.
2. Run the pstack `/statechart` skill on `model/IdentityAccess.tla` with config `model/IdentityAccess.cfg` and view `model/view.ts`, writing to a new scratch folder outside the repo. About 2,600 states, a few seconds after the first install.
3. For the two user-flow charts, run the same command with `model/FlowSession.cfg` and `model/view-flow-session.ts`, and with `model/FlowAdmin.cfg` and `model/view-flow-admin.ts`. Copy each `chart.mmd` to `docs/state-machines/charts/identity-access-1.mmd` or `identity-access-2.mmd`, then render it to SVG as `references/render.md` says, and put the SVG in `docs/state-machines/charts/` with the same name. Also replace the matching inline SVG in `docs/state-machines/charts/tabs.html`.

Expected result today: every rule **holds**: `TypeOK, AtMostOneAdmin, AdminIsEnabled, AdminWhileEnabledUsers, AccessNeedsEnabledUser, ResetSingleUse, DeletedLeavesNothing, ResetEndsOldSessions, ResetEndsOldShortcuts, ResetNotRevivedByEnable, NoDeadlock`. Any rule breaking needs your attention.

To check that each rule can still fail, copy the model to a scratch folder and break one action in it. For example, let `UseSession` accept a stale session (`sess[u] # "none"`), leave the reset code in `Disable`, or keep `cred` in `ConsumeReset`. Each change must break exactly the rule it guards (`ResetEndsOldSessions`, `ResetNotRevivedByEnable`, `ResetEndsOldShortcuts`).

## Fixed findings (fixed in ea526d7)

These were rule breaks. Do not weaken the rules to make them pass.

1. **`ResetEndsOldSessions`** is fixed. Alice signs in, the admin issues her a reset code, and she uses it. Her old browser session used to stay signed in. A password reset now bumps `users.session_version`, and `currentUser` accepts only a token whose `sessionVersion` claim matches it.
2. **`ResetEndsOldShortcuts`** is fixed. A password reset now clears `shortcut_credential_hash` in the same transaction as the new password.
3. **`ResetNotRevivedByEnable`** is fixed. Disabling now drops a live reset code (`nextAccountState`, `disable`), so re-enabling cannot revive it.

4. **Login that outlives a reset** is fixed in a later review fix. The model's `Login` is one atomic step, so it could not show this race. The login route checks the password against a row it read earlier, and `setSession` used to reread `session_version` after that async check. A reset that committed in between gave the old-password login a token for the new version. `setSession` now takes the version from the caller's verified row, and `code-guards.sh` checks that it stays a parameter. Replayed by `tests/login-session.test.ts`.

Also true of the code, not a rule violation and not changed: if the only admin deletes their account while every other user is disabled, no admin remains (the handoff rule only applies to *enabled* users), and the next person to register becomes admin (`roleForRegistration`). This is an open product call. The two-person flow chart shows it.

Also true of the code, not a rule violation and not changed: disabling does not end a browser session or a Shortcut credential. Both are refused while the user is disabled, and both work again after re-enabling. Whether a disable should revoke them is an open product call.

## When a check fails

- `MISSING` from `code-guards.sh`: the code changed on purpose or by mistake. Open the file, decide which. If intended, update the matching action in `IdentityAccess.tla`, update `code-guards.sh`, and re-run.
- A "holds" rule breaks in `/statechart`: read its path. Replay it against the real code (a store call per step, as in `tests/store.test.ts`). If the code really does that, it is a bug: report it with the path in plain words. If the code does not, the model is wrong; fix the model action, never the rule.
- Intended behaviour change (for example, revoking sessions on disable): change the action in `IdentityAccess.tla`, add or change the rule, and update the doc `docs/state-machines/identity-access.md`.

## Files

- `model/IdentityAccess.tla` — the model. Two people, `Users` is a constant (`UsersTwo`, `UsersOne`).
- `model/IdentityAccess.cfg` is the full check. `model/FlowSession.cfg` and `model/FlowAdmin.cfg` hold the same rules for the two flow charts.
- `model/view.ts`, `model/view-flow-session.ts`, `model/view-flow-admin.ts` — the words on the charts.
- `model/code-guards.sh` — structural conformance check.
- `docs/state-machines/identity-access.md` — inventory and charts.

## What is not covered

Two users only; at most one outstanding reset code per user; time is one step (a code is live or expired). A session is live or stale; the model does not track which browser holds which session. Not modeled: password verification, rate limits, same-origin checks, JWT signature and expiry, sessions and Shortcut credentials after a disable (an open product call), goal and debt side effects of deleting an account (see the goals skill), other tables. A pass says the model holds under those bounds, and `code-guards.sh` says the listed guards still exist. It does not prove the code equals the model.
