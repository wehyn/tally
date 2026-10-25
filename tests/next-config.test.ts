import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("LAN development access", () => {
  it("allows the app LAN hostname to load Next.js development resources", () => {
    expect(nextConfig.allowedDevOrigins).toContain("192.168.2.28");
  });
});

describe("dashboard embedding", () => {
  it("lets only the dashboard origin frame Tally", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const headers = new Map(rules.flatMap((rule) => rule.headers.map((header) => [header.key, header.value])));
    expect(headers.has("X-Frame-Options")).toBe(false);
    expect(headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self' http://192.168.2.28:10000");
  });
});
