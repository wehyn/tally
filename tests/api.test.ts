import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSameOrigin, clientKey, requestJson } from "../src/lib/api";

afterEach(() => vi.unstubAllEnvs());

describe("JSON request limits", () => {
  it("rejects bodies over 64 KB even when Content-Length is absent", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(64_100) }),
    });

    await expect(requestJson(request, { parse: (value) => value })).rejects.toMatchObject({ status: 413 });
  });

  it("ignores client-supplied forwarded addresses unless trusted-proxy mode is enabled", () => {
    const request = new Request("http://localhost/api", { headers: { "x-forwarded-for": "203.0.113.4" } });
    vi.stubEnv("TALLY_TRUST_PROXY", "false");
    expect(clientKey(request)).toBe("untrusted-proxy");

    vi.stubEnv("TALLY_TRUST_PROXY", "true");
    expect(clientKey(request)).toBe("203.0.113.4");
    const chain = new Request("http://localhost/api", { headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.4" } });
    expect(clientKey(chain)).toBe("untrusted-proxy");
  });
});

describe("same-origin validation", () => {
  it("uses the incoming Host when the standalone server's request URL is internal", () => {
    vi.stubEnv("TALLY_TRUST_PROXY", "false");
    const request = new Request("http://0.0.0.0:3001/api/auth/register", {
      headers: { origin: "http://127.0.0.1:3001", host: "127.0.0.1:3001" },
    });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("uses one trusted forwarded scheme and host behind a TLS proxy", () => {
    vi.stubEnv("TALLY_TRUST_PROXY", "true");
    const request = new Request("http://0.0.0.0:3001/api/auth/register", {
      headers: {
        origin: "https://tally.example",
        host: "tally.internal:3001",
        "x-forwarded-host": "tally.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("rejects ambiguous forwarded origins and mismatched browser origins", () => {
    vi.stubEnv("TALLY_TRUST_PROXY", "true");
    const ambiguous = new Request("http://app:3000/api", {
      headers: { origin: "https://tally.example", host: "app:3000", "x-forwarded-host": "tally.example, evil.example", "x-forwarded-proto": "https" },
    });
    expect(() => assertSameOrigin(ambiguous)).toThrow(/origin/i);
    const mismatch = new Request("http://app:3000/api", {
      headers: { origin: "https://attacker.example", host: "app:3000", "x-forwarded-host": "tally.example", "x-forwarded-proto": "https" },
    });
    expect(() => assertSameOrigin(mismatch)).toThrow(/origin/i);
    const malformedOrigin = new Request("http://app:3000/api", {
      headers: { origin: "https://attacker@tally.example/path", host: "app:3000", "x-forwarded-host": "tally.example", "x-forwarded-proto": "https" },
    });
    expect(() => assertSameOrigin(malformedOrigin)).toThrow(/origin/i);
  });
});
