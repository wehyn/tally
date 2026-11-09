// Pure rules for one user account: enabled or disabled, role, and the credentials that sign it in.
// The store reads the account row, asks this module for the next state, and writes that state back.
// Nothing here touches the database or the clock.

export type AccountRole = "admin" | "user";

// A reset code is "live" until it is used or its 15 minutes pass. The store decides "expired" from the
// stored expiry time and passes it in. The Shortcut credential is "live" until it is revoked or a reset uses it.
export type ResetCredential = "none" | "live" | "expired";
export type ShortcutCredential = "none" | "live";

// sessionVersion counts password resets. A browser session carries the version it was issued under,
// and only a session with the current version is accepted.
export type AccountState = {
  enabled: boolean;
  reset: ResetCredential;
  shortcut: ShortcutCredential;
  sessionVersion: number;
};

export type AccountEvent = "disable" | "enable" | "issueReset" | "resetPassword";

// Returns the state after the event, or null when the event is refused in this state.
export function nextAccountState(state: AccountState, event: AccountEvent): AccountState | null {
  switch (event) {
    // Disabling drops any reset code, so enabling again cannot bring it back.
    case "disable":
      return { ...state, enabled: false, reset: "none" };
    case "enable":
      return { ...state, enabled: true };
    // Only an enabled account can receive a reset code, and a new code replaces an earlier one.
    case "issueReset":
      return state.enabled ? { ...state, reset: "live" } : null;
    // Using the code ends every earlier session and the Shortcut credential.
    case "resetPassword":
      return state.enabled && state.reset === "live"
        ? { enabled: true, reset: "none", shortcut: "none", sessionVersion: state.sessionVersion + 1 }
        : null;
  }
}

export function roleForRegistration(adminExists: boolean): AccountRole {
  return adminExists ? "user" : "admin";
}

export type DeleteRefusal = "handoff-required" | "handoff-not-enabled";

// Deleting an admin hands admin to another enabled user when one exists. With no other enabled user,
// the deletion goes ahead and leaves no admin. That is an open product call, not a refusal.
export function deleteRefusal(role: AccountRole, enabledOthers: readonly string[], handoffTo: string | undefined): DeleteRefusal | null {
  if (role !== "admin") return null;
  if (!handoffTo) return enabledOthers.length ? "handoff-required" : null;
  return enabledOthers.includes(handoffTo) ? null : "handoff-not-enabled";
}
