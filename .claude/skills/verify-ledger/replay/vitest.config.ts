import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs only the ledger replay. Root is the repo root so `@/` and node_modules resolve as in the app.
export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../../../src", import.meta.url)) } },
  test: { environment: "node", include: [".claude/skills/verify-ledger/replay/*.test.ts"] },
});
