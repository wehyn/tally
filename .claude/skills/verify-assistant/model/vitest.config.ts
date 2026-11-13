import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs only conformance.test.ts, against the real store, route and runAssistantPrompt.
export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../../../src", import.meta.url)) } },
  test: { environment: "node", include: [".claude/skills/verify-assistant/model/conformance.test.ts"], restoreMocks: true },
});
