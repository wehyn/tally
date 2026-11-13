import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
export default defineConfig({
  root: repo,
  resolve: { alias: { "@": `${repo}src` } },
  test: { environment: "node", include: [".claude/skills/verify-bills/model/*.test.ts"], testTimeout: 300_000 },
});
