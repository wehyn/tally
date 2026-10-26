export function normalizeCounterparty(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").replace(/\s+/g, " ").trim();
}
