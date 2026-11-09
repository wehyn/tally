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
need $S "SELECT reset_token_hash, reset_expires_at FROM users WHERE id = ? AND enabled = 1" "ConsumeReset needs an enabled user (ResetSingleUse)"
need $S "SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL" "ConsumeReset clears the credential (ResetSingleUse)"
need $S "row.reset_expires_at < stamp()" "Expire: an old credential is refused (ResetSingleUse)"
need $S "WHERE shortcut_credential_hash=? AND enabled=1" "UseShortcut needs an enabled user (AccessNeedsEnabledUser)"
need $S "Choose an enabled user to receive admin access before deleting this account." "DeleteAccount: handoff required while another enabled user exists (AdminWhileEnabledUsers)"
need $S "Admin handoff must go to another enabled user." "DeleteAccount: handoff target must be enabled (AdminIsEnabled)"
need $S "UPDATE users SET role='admin' WHERE id=? AND enabled=1" "DeleteAccount: handoff makes exactly one new admin (AtMostOneAdmin)"
need $S "UPDATE users SET role='user' WHERE id=?" "DeleteAccount: old admin steps down (AtMostOneAdmin)"
need src/lib/auth.ts "if (!user || !user.enabled) return null;" "UseSession needs an enabled user (AccessNeedsEnabledUser)"
need src/app/api/auth/login/route.ts "!user.enabled" "Login needs an enabled user"
need src/app/api/admin/users/\[id\]/reset/route.ts "!user.enabled" "IssueReset needs an enabled user"
need src/app/api/admin/users/\[id\]/reset/route.ts "15 * 60_000" "Expire: reset credential lifetime"
need src/app/api/admin/users/route.ts "requireAdmin(admin)" "Disable/Enable are admin-only"
need src/app/api/account/route.ts "adminHandoffTo" "DeleteAccount passes the handoff target"
# Findings: password reset must not (yet) touch sessions or credentials. If this starts matching, the findings may be fixed.
if grep -qE "shortcut_credential_hash *= *NULL|session_version|token_version" "$root/$S" 2>/dev/null; then
  echo "NOTE: $S now mentions credential or session revocation; re-check ResetEndsOldSessions / ResetEndsOldShortcuts."
fi
[ $bad = 0 ] && echo "All identity-access guards present." || exit 1
