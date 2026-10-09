import { hash } from "bcryptjs";
import { z } from "zod";
import { setSession } from "@/lib/auth";
import { assertSameOrigin, clientKey, HttpError, limiter, requestJson, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";

const schema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_]+$/), password: z.string().min(12).max(128) });
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!limiter(`register:${clientKey(request)}`, 8, 60 * 60 * 1000)) throw new HttpError(429, "Too many registrations from this network. Try again later.");
    const input = await requestJson(request, schema);
    const user = getStore().registerUser(input.username, await hash(input.password, 12));
    await setSession(user);
    return Response.json({ user: { id: user.id, username: user.username, role: user.role } }, { status: 201 });
  } catch (error) { return respondError(error); }
}
