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
  wd,      \* a live reset credential was left behind while the user was disabled
  sess,    \* signed-in browser session: "none" | "live" | "livePrePw" (issued before the last password reset)
  cred,    \* shortcut_credential_hash: "none" | "live" | "livePrePw"
  ev       \* the last access decision, for rules about what was allowed

vars == <<status, role, reset, wd, sess, cred, ev>>
NoEv == [kind |-> "none", u |-> Missing]
Others(u) == {v \in Users \ {u} : status[v] = "active"}

Init ==
  /\ status = [u \in Users |-> "absent"] /\ role = [u \in Users |-> "none"]
  /\ reset = [u \in Users |-> "none"] /\ wd = [u \in Users |-> FALSE]
  /\ sess = [u \in Users |-> "none"] /\ cred = [u \in Users |-> "none"]
  /\ ev = NoEv

\* registerUser (store.ts): first user, when no admin row exists, becomes admin.
Register(u) ==
  /\ status[u] = "absent"
  /\ status' = [status EXCEPT ![u] = "active"]
  /\ role' = [role EXCEPT ![u] = IF \E v \in Users : role[v] = "admin" THEN "user" ELSE "admin"]
  /\ ev' = NoEv /\ UNCHANGED <<reset, wd, sess, cred>>

\* auth/login route: only an enabled user gets a session.
Login(u) ==
  /\ status[u] = "active"
  /\ sess' = [sess EXCEPT ![u] = "live"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, wd, cred>>

Logout(u) ==
  /\ sess[u] # "none"
  /\ sess' = [sess EXCEPT ![u] = "none"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, wd, cred>>

\* currentUser (auth.ts): a session works only while the user row exists and is enabled.
UseSession(u) ==
  /\ status[u] = "active" /\ sess[u] # "none"
  /\ ev' = [kind |-> "session", u |-> u] /\ UNCHANGED <<status, role, reset, wd, sess, cred>>

\* findEnabledUserByShortcutCredentialHash (store.ts).
UseShortcut(u) ==
  /\ status[u] = "active" /\ cred[u] # "none"
  /\ ev' = [kind |-> "shortcut", u |-> u] /\ UNCHANGED <<status, role, reset, wd, sess, cred>>

\* setUserEnabled (store.ts): an admin cannot disable themself.
Disable(a, u) ==
  /\ role[a] = "admin" /\ a # u /\ status[u] = "active"
  /\ status' = [status EXCEPT ![u] = "disabled"]
  /\ wd' = [wd EXCEPT ![u] = (reset[u] = "live")]
  /\ ev' = NoEv /\ UNCHANGED <<role, reset, sess, cred>>

Enable(a, u) ==
  /\ role[a] = "admin" /\ status[u] = "disabled"
  /\ status' = [status EXCEPT ![u] = "active"]
  /\ ev' = NoEv /\ UNCHANGED <<role, reset, wd, sess, cred>>

\* admin reset route + setResetCredential: only an enabled user; replaces any earlier credential.
IssueReset(a, u) ==
  /\ role[a] = "admin" /\ status[u] = "active"
  /\ reset' = [reset EXCEPT ![u] = "live"] /\ wd' = [wd EXCEPT ![u] = FALSE]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, sess, cred>>

\* 15 minutes pass.
Expire(u) ==
  /\ reset[u] = "live"
  /\ reset' = [reset EXCEPT ![u] = "expired"] /\ wd' = [wd EXCEPT ![u] = FALSE]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, sess, cred>>

\* consumeResetCredential (store.ts): enabled user, matching live credential; clears it.
\* The password hash changes. Sessions and the shortcut credential are NOT touched by the code.
ConsumeReset(u) ==
  /\ status[u] = "active" /\ reset[u] = "live"
  /\ reset' = [reset EXCEPT ![u] = "none"] /\ wd' = [wd EXCEPT ![u] = FALSE]
  /\ sess' = [sess EXCEPT ![u] = IF sess[u] = "none" THEN "none" ELSE "livePrePw"]
  /\ cred' = [cred EXCEPT ![u] = IF cred[u] = "none" THEN "none" ELSE "livePrePw"]
  /\ ev' = [kind |-> "consume", u |-> u] /\ UNCHANGED <<status, role>>

\* shortcut-credential route: signed-in user rotates (POST) or revokes (DELETE).
SetCred(u) ==
  /\ status[u] = "active"
  /\ cred' = [cred EXCEPT ![u] = "live"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, wd, sess>>

ClearCred(u) ==
  /\ status[u] = "active" /\ cred[u] # "none"
  /\ cred' = [cred EXCEPT ![u] = "none"]
  /\ ev' = NoEv /\ UNCHANGED <<status, role, reset, wd, sess>>

\* deleteAccountOwner (store.ts): an admin needs another enabled user as handoff target
\* when one exists; the row and everything on it disappear.
DeleteAccount(u, h) ==
  /\ status[u] = "active"
  /\ IF role[u] = "admin" THEN (IF Others(u) = {} THEN h = Missing ELSE h \in Others(u)) ELSE h = Missing
  /\ status' = [status EXCEPT ![u] = "absent"]
  /\ role' = [v \in Users |-> IF v = u THEN "none" ELSE IF v = h THEN "admin" ELSE role[v]]
  /\ reset' = [reset EXCEPT ![u] = "none"] /\ wd' = [wd EXCEPT ![u] = FALSE]
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
  /\ sess' = sess /\ cred' = cred /\ reset' = reset /\ ev' = NoEv

\* ---- Rules that must hold ----
TypeOK ==
  /\ status \in [Users -> {"absent", "active", "disabled"}]
  /\ role \in [Users -> {"none", "admin", "user"}]
  /\ reset \in [Users -> {"none", "live", "expired"}]
  /\ sess \in [Users -> {"none", "live", "livePrePw"}] /\ cred \in [Users -> {"none", "live", "livePrePw"}]
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

\* ---- Rules the current code breaks (findings) ----
\* After a password reset, no session issued before it still works.
ResetEndsOldSessions == \A u \in Users : sess[u] # "livePrePw"
\* After a password reset, no shortcut credential issued before it still works.
ResetEndsOldShortcuts == \A u \in Users : cred[u] # "livePrePw"
\* A reset credential issued before a disable does not come back when the user is re-enabled.
ResetNotRevivedByEnable == \A u \in Users : (status[u] = "active" /\ reset[u] = "live") => ~wd[u]
====
