---- MODULE IdentityAccess ----
\* Model of Tally's identity-access subsystem. One TLA+ action = one store call / route handler
\* that runs as a single SQLite transaction or a single UPDATE (src/lib/store.ts).
EXTENDS Naturals, FiniteSets

CONSTANT Users
UsersTwo == {"u1", "u2"}   \* the full check
UsersOne == {"u1"}         \* the single-person flow chart
Missing == "none"

VARIABLES
  status,  \* users row: "absent" | "active" (enabled=1) | "disabled" (enabled=0)
  role,    \* users.role: "none" (no row) | "admin" | "user"
  reset,   \* reset_token_hash/reset_expires_at: "none" | "live" | "expired"
  sess,    \* browser session: "none" | "live" | "stale" (issued before the last password reset)
  cred,    \* shortcut_credential_hash: "none" | "live"
  ev       \* the last access decision, for rules about what was allowed

vars == <<status, role, reset, sess, cred, ev>>
NoEv == [kind |-> "none", u |-> Missing]
Others(u) == {v \in Users \ {u} : status[v] = "active"}

Init ==
  /\ status = [u \in Users |-> "absent"] /\ role = [u \in Users |-> "none"]
  /\ reset = [u \in Users |-> "none"]
  /\ sess = [u \in Users |-> "none"] /\ cred = [u \in Users |-> "none"]
  /\ ev = NoEv

\* registerUser (store.ts): first user, when no admin row exists, becomes admin.
Register(u) ==
  /\ status[u] = "absent"
  /\ status' = [status EXCEPT ![u] = "active"]
  /\ role' = [role EXCEPT ![u] = IF \E v \in Users : role[v] = "admin" THEN "user" ELSE "admin"]
  /\ ev' = NoEv /\ UNCHANGED <<reset, sess, cred>>

\* auth/login route: only an enabled user gets a session.
Login(u) ==
  /\ status[u] = "active"
  /\ sess' = [sess EXCEPT ![u] = "live"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, cred>>

Logout(u) ==
  /\ sess[u] # "none"
  /\ sess' = [sess EXCEPT ![u] = "none"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, cred>>

\* currentUser (auth.ts): a session works only while the user row exists, is enabled, and the
\* session's version matches the user's (a password reset bumps it, so earlier sessions are refused).
UseSession(u) ==
  /\ status[u] = "active" /\ sess[u] = "live"
  /\ ev' = [kind |-> "session", u |-> u] /\ UNCHANGED <<status, role, reset, sess, cred>>

\* findEnabledUserByShortcutCredentialHash (store.ts).
UseShortcut(u) ==
  /\ status[u] = "active" /\ cred[u] # "none"
  /\ ev' = [kind |-> "shortcut", u |-> u] /\ UNCHANGED <<status, role, reset, sess, cred>>

\* setUserEnabled (store.ts): an admin cannot disable themself. Disabling drops a live reset code.
Disable(a, u) ==
  /\ role[a] = "admin" /\ a # u /\ status[u] = "active"
  /\ status' = [status EXCEPT ![u] = "disabled"]
  /\ reset' = [reset EXCEPT ![u] = "none"]
  /\ ev' = NoEv /\ UNCHANGED <<role, sess, cred>>

Enable(a, u) ==
  /\ role[a] = "admin" /\ status[u] = "disabled"
  /\ status' = [status EXCEPT ![u] = "active"]
  /\ ev' = [kind |-> "enable", u |-> u] /\ UNCHANGED <<role, reset, sess, cred>>

\* admin reset route + setResetCredential: only an enabled user; replaces any earlier credential.
IssueReset(a, u) ==
  /\ role[a] = "admin" /\ status[u] = "active"
  /\ reset' = [reset EXCEPT ![u] = "live"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, sess, cred>>

\* 15 minutes pass.
Expire(u) ==
  /\ reset[u] = "live"
  /\ reset' = [reset EXCEPT ![u] = "expired"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, sess, cred>>

\* consumeResetCredential (store.ts): enabled user, matching live credential. It sets the new password,
\* clears the credential, bumps the session version (earlier sessions become stale) and clears the Shortcut credential.
ConsumeReset(u) ==
  /\ status[u] = "active" /\ reset[u] = "live"
  /\ reset' = [reset EXCEPT ![u] = "none"]
  /\ sess' = [sess EXCEPT ![u] = IF sess[u] = "live" THEN "stale" ELSE sess[u]]
  /\ cred' = [cred EXCEPT ![u] = "none"]
  /\ ev' = [kind |-> "consume", u |-> u] /\ UNCHANGED <<status, role>>

\* shortcut-credential route: signed-in user rotates (POST) or revokes (DELETE).
SetCred(u) ==
  /\ status[u] = "active"
  /\ cred' = [cred EXCEPT ![u] = "live"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, sess>>

ClearCred(u) ==
  /\ status[u] = "active" /\ cred[u] # "none"
  /\ cred' = [cred EXCEPT ![u] = "none"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, sess>>

\* deleteAccountOwner (store.ts): an admin needs another enabled user as handoff target
\* when one exists; the row and everything on it disappear.
DeleteAccount(u, h) ==
  /\ status[u] = "active"
  /\ IF role[u] = "admin" THEN (IF Others(u) = {} THEN h = Missing ELSE h \in Others(u)) ELSE h = Missing
  /\ status' = [status EXCEPT ![u] = "absent"]
  /\ role' = [v \in Users |-> IF v = u THEN "none" ELSE IF v = h THEN "admin" ELSE role[v]]
  /\ reset' = [reset EXCEPT ![u] = "none"]
  /\ sess' = [sess EXCEPT ![u] = "none"] /\ cred' = [cred EXCEPT ![u] = "none"]
  /\ ev' = NoEv

Next ==
  \/ \E u \in Users : Register(u) \/ Login(u) \/ Logout(u) \/ UseSession(u) \/ UseShortcut(u)
       \/ Expire(u) \/ ConsumeReset(u) \/ SetCred(u) \/ ClearCred(u)
  \/ \E a, u \in Users : Disable(a, u) \/ Enable(a, u) \/ IssueReset(a, u)
  \/ \E u \in Users, h \in Users \cup {Missing} : DeleteAccount(u, h)

Spec == Init /\ [][Next]_vars

\* Used only by the admin-management flow chart: no sessions, credentials or reset codes.
AccountsOnly ==
  /\ sess' = sess /\ cred' = cred /\ reset' = reset /\ ev'.kind \in {"none", "enable"}

\* ---- Rules that must hold ----
TypeOK ==
  /\ status \in [Users -> {"absent", "active", "disabled"}]
  /\ role \in [Users -> {"none", "admin", "user"}]
  /\ reset \in [Users -> {"none", "live", "expired"}]
  /\ sess \in [Users -> {"none", "live", "stale"}] /\ cred \in [Users -> {"none", "live"}]
  /\ \A u \in Users : (status[u] = "absent") = (role[u] = "none")

AtMostOneAdmin == Cardinality({u \in Users : role[u] = "admin"}) <= 1
AdminIsEnabled == \A u \in Users : role[u] = "admin" => status[u] = "active"
\* An enabled user never exists without an admin to manage them (deletion needs a handoff).
AdminWhileEnabledUsers ==
  (\E u \in Users : status[u] = "active") => (\E u \in Users : role[u] = "admin")
\* A session or shortcut credential never authenticates a disabled or deleted user.
AccessNeedsEnabledUser == ev.kind \in {"session", "shortcut"} => status[ev.u] = "active"
\* A reset credential works once, and never for a disabled user.
ResetSingleUse == ev.kind = "consume" => (reset[ev.u] = "none" /\ status[ev.u] = "active")
\* Nothing is left of a deleted user.
DeletedLeavesNothing ==
  \A u \in Users : status[u] = "absent" => (reset[u] = "none" /\ sess[u] = "none" /\ cred[u] = "none")

\* ---- Rules about the password reset and credential generations (fixed) ----
\* A reset ends every browser session issued before it: the session that was accepted, if any, was current.
ResetEndsOldSessions == ev.kind = "session" => sess[ev.u] = "live"
\* A reset ends the Shortcut credential.
ResetEndsOldShortcuts == ev.kind = "consume" => cred[ev.u] = "none"
\* Re-enabling a user never brings back a reset code issued before the disable.
ResetNotRevivedByEnable == ev.kind = "enable" => reset[ev.u] = "none"
====
