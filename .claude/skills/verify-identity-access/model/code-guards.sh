#!/bin/sh
# Checks that each guard the IdentityAccess model relies on is still present in the real code.
# Usage: code-guards.sh [repo-root]   Exit 0 = all present; exit 1 = lists the missing guards and
# the model rule each one protects. A missing guard means the model no longer describes the code.
root=${1:-$(git rev-parse --show-toplevel)}
bad=0
need() { # file, fixed text, what the model does with it
  if ! grep -qF -- "$2" "$root/$1"; then echo "MISSING in $1: $2   -> $3"; bad=1; fi
}
S=src/lib/store.ts
need $S "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1" "Register: first user is admin only when no admin exists (AtMostOneAdmin)"
need $S "if (adminId === userId) throw new Error(\"You cannot disable your own admin account.\")" "Disable: a<>u (AdminIsEnabled)"
need src/lib/machines/identity.ts "return state.enabled && state.reset === \"live\"" "ConsumeReset needs an enabled user and a live credential (ResetSingleUse)"
need src/lib/machines/identity.ts "{ enabled: true, reset: \"none\", shortcut: \"none\", sessionVersion: state.sessionVersion + 1 }" "ConsumeReset clears the credential, ends sessions and clears the Shortcut credential (ResetEndsOldSessions, ResetEndsOldShortcuts)"
need $S "UPDATE users SET password_hash = ? WHERE id = ?" "ConsumeReset sets the new password only through the machine (ResetSingleUse)"
need $S "row.reset_expires_at < now" "Expire: an old credential is refused (ResetSingleUse)"
need $S "reset_token_hash = CASE WHEN ? = 'live' THEN reset_token_hash END" "Saving a state clears a reset code the machine no longer holds (ResetSingleUse, ResetNotRevivedByEnable)"
need $S "shortcut_credential_hash = CASE WHEN ? = 'live' THEN shortcut_credential_hash END" "Saving a state clears the Shortcut credential the machine no longer holds (ResetEndsOldShortcuts)"
need src/lib/machines/identity.ts "return { ...state, enabled: false, reset: \"none\" };" "Disable drops a live reset code (ResetNotRevivedByEnable)"
need $S "session_version = ?," "Saving a state writes the session version (ResetEndsOldSessions)"
need $S "WHERE shortcut_credential_hash=? AND enabled=1" "UseShortcut needs an enabled user (AccessNeedsEnabledUser)"
need $S "Choose an enabled user to receive admin access before deleting this account." "DeleteAccount: handoff required while another enabled user exists (AdminWhileEnabledUsers)"
need $S "Admin handoff must go to another enabled user." "DeleteAccount: handoff target must be enabled (AdminIsEnabled)"
need $S "UPDATE users SET role='admin' WHERE id=? AND enabled=1" "DeleteAccount: handoff makes exactly one new admin (AtMostOneAdmin)"
need $S "UPDATE users SET role='user' WHERE id=?" "DeleteAccount: old admin steps down (AtMostOneAdmin)"
need src/lib/auth.ts "if (!user || !user.enabled || payload.sessionVersion !== user.sessionVersion) return null;" "UseSession needs an enabled user and a current session version (AccessNeedsEnabledUser, ResetEndsOldSessions)"
need src/lib/auth.ts "new SignJWT({ role: user.role, sessionVersion: user.sessionVersion })" "Login stamps the session version into the token (ResetEndsOldSessions)"
need src/lib/auth.ts "{ sessionVersion: number }) {" "setSession takes the version from the caller's verified row and never rereads it, so a reset between the password check and the cookie cannot be skipped (ResetEndsOldSessions)"
need src/app/api/auth/login/route.ts "!user.enabled" "Login needs an enabled user"
need src/app/api/admin/users/\[id\]/reset/route.ts "!user.enabled" "IssueReset needs an enabled user"
need src/app/api/admin/users/\[id\]/reset/route.ts "15 * 60_000" "Expire: reset credential lifetime"
need src/app/api/admin/users/route.ts "requireAdmin(admin)" "Disable/Enable are admin-only"
need src/app/api/account/route.ts "adminHandoffTo" "DeleteAccount passes the handoff target"
[ $bad = 0 ] && echo "All identity-access guards present." || exit 1
