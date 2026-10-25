import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("LAN development access", () => {
  it("allows the app LAN hostname to load Next.js development resources", () => {
    expect(nextConfig.allowedDevOrigins).toContain("192.168.2.28");
  });
});

describe("dashboard embedding", () => {
  it("admits only Tally's own origin and the dashboard origin as frame ancestors", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const documentRule = rules.find((rule) => rule.source === "/(.*)");
    expect(documentRule).toBeDefined();
    const headers = new Map(documentRule?.headers.map((header) => [header.key, header.value]));
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(headers.get("Content-Security-Policy")?.split(" ")).toEqual([
      "frame-ancestors",
      "'self'",
      "http://192.168.2.28:10000",
    ]);
  });
});
