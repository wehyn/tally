import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("LAN development access", () => {
  it("allows the app LAN hostname to load Next.js development resources", () => {
    expect(nextConfig.allowedDevOrigins).toContain("192.168.2.28");
  });
});
