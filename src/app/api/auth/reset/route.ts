import { createHash } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { assertSameOrigin, clientKey, HttpError, limiter, requestJson, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";

const schema = z.object({ username: z.string().trim().min(3).max(32), token: z.string().min(32).max(128), password: z.string().min(12).max(128) });
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!limiter(`reset:${clientKey(request)}`, 8, 15 * 60 * 1000)) throw new HttpError(429, "Too many reset attempts.");
    const input = await requestJson(request, schema);
    const user = getStore().getUserByUsername(input.username);
    if (!user || !getStore().consumeResetCredential(user.id, createHash("sha256").update(input.token).digest("hex"), await hash(input.password, 12))) {
      throw new HttpError(400, "That one-time reset credential is invalid or expired.");
    }
    return Response.json({ ok: true });
  } catch (error) { return respondError(error); }
}
