import { createHash } from "node:crypto";

export function hashShortcutCredential(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}
