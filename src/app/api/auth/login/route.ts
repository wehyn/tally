import { compare } from "bcryptjs";
import { z } from "zod";
import { setSession } from "@/lib/auth";
import { assertSameOrigin, clientKey, HttpError, limiter, requestJson, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";

const schema = z.object({ username: z.string().trim().min(1).max(32), password: z.string().min(1).max(128) });
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!limiter(`login:${clientKey(request)}`, 8, 15 * 60 * 1000)) throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    const input = await requestJson(request, schema);
    const user = getStore().getUserByUsername(input.username);
    if (!user || !user.enabled || !(await compare(input.password, user.passwordHash))) throw new HttpError(401, "Username or password is incorrect.");
    await setSession(user);
    return Response.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) { return respondError(error); }
}
