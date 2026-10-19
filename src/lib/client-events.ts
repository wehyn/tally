export const LEDGER_UPDATED_EVENT = "tally:ledger-updated";
export const BILLS_UPDATED_EVENT = "tally:bills-updated";
export const DEBTS_UPDATED_EVENT = "tally:debts-updated";
export const ASSISTANT_SETTINGS_UPDATED_EVENT = "tally:assistant-settings-updated";

export type AssistantAvailability = Readonly<{ enabled: boolean; configured: boolean }>;

export function assistantAvailabilityFromEvent(event: Event): AssistantAvailability | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (
    typeof detail !== "object" ||
    detail === null ||
    !("enabled" in detail) ||
    !("configured" in detail)
  ) return null;
  const { enabled, configured } = detail;
  if (typeof enabled !== "boolean" || typeof configured !== "boolean" || (enabled && !configured)) return null;
  return { enabled, configured };
}
