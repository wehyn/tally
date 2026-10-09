import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { currentUser } from "./auth";
import type { PublicUser } from "./store";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function requireUser(): Promise<PublicUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}
export function requireAdmin(user: PublicUser): void {
  if (user.role !== "admin") throw new HttpError(403, "Admin access is required.");
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") throw new HttpError(403, "Cross-site requests are not allowed.");

  const requestUrl = new URL(request.url);
  const trustedProxy = process.env.TALLY_TRUST_PROXY === "true";
  const hostHeader = request.headers.get("host")?.trim() || requestUrl.host;
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
  let protocol = requestUrl.protocol;
  let host = hostHeader;
  if (trustedProxy && (forwardedHost || forwardedProto)) {
    if (!forwardedHost || !forwardedProto || forwardedHost.includes(",") || forwardedProto.includes(",") || !["http", "https"].includes(forwardedProto)) {
      throw new HttpError(403, "Request origin could not be verified.");
    }
    host = forwardedHost;
    protocol = `${forwardedProto}:`;
  }
  if (!host || host.includes(",")) throw new HttpError(403, "Request origin could not be verified.");

  let expectedOrigin: string;
  try {
    const target = new URL(`${protocol}//${host}`);
    if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Invalid host.");
    expectedOrigin = target.origin;
  } catch {
    throw new HttpError(403, "Request origin could not be verified.");
  }
  let receivedOrigin: URL;
  try {
    if (!origin) throw new Error("Missing origin.");
    receivedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Request origin could not be verified.");
  }
  if (receivedOrigin.username || receivedOrigin.password || receivedOrigin.pathname !== "/" || receivedOrigin.search || receivedOrigin.hash || !["http:", "https:"].includes(receivedOrigin.protocol) || receivedOrigin.origin !== expectedOrigin) {
    throw new HttpError(403, "Request origin could not be verified.");
  }
}
export async function requestJson<T>(request: Request, schema: { parse(value: unknown): T }): Promise<T> {
  const maxBytes = 64_000;
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) throw new HttpError(413, "Request body is too large.");

  let text: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Request body is empty.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new HttpError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON.");
  }

  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, "Request body must be valid JSON."); }
  try { return schema.parse(body); } catch (error) {
    const message = error instanceof Error ? error.message : "Request is invalid.";
    throw new HttpError(400, message.slice(0, 240));
  }
}
export function respondError(error: unknown): NextResponse {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "Request failed.";
  const status = /not found/i.test(message) ? 404 : /already taken|unique constraint/i.test(message) ? 409 : 400;
  return NextResponse.json({ error: message.slice(0, 240) }, { status });
}
export const limiter = (() => {
  const buckets = new Map<string, { count: number; expires: number }>();
  return (key: string, max: number, windowMs: number) => {
    const now = Date.now();
    for (const [id, value] of buckets) if (value.expires <= now) buckets.delete(id);
    const current = buckets.get(key);
    if (!current || current.expires <= now) { buckets.set(key, { count: 1, expires: now + windowMs }); return true; }
    current.count += 1;
    return current.count <= max;
  };
})();
export function clientKey(request: Request): string {
  if (process.env.TALLY_TRUST_PROXY !== "true") return "untrusted-proxy";
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "untrusted-proxy";
  const values = forwarded.split(",").map((value) => value.trim());
  if (values.length !== 1 || isIP(values[0]) === 0) return "untrusted-proxy";
  return values[0];
}
