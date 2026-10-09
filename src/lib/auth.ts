import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getStore } from "./db";
import type { PublicUser } from "./store";

const COOKIE_NAME = "tally_session";
const TTL_SECONDS = 60 * 60 * 24 * 7;
function secretKey() {
  const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === "production" ? "" : "local-development-only-session-secret-change-me");
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
  return new TextEncoder().encode(secret);
}

export async function setSession(user: Pick<PublicUser, "id" | "role">) {
  const token = await new SignJWT({ role: user.role }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime(`${TTL_SECONDS}s`).sign(secretKey());
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TTL_SECONDS });
}

export async function clearSession() {
  const jar = await cookies();
  jar.set(COOKIE_NAME, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
}

export async function currentUser(): Promise<PublicUser | null> {
  try {
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    const user = getStore().getUserById(payload.sub);
    if (!user || !user.enabled) return null;
    return { id: user.id, username: user.username, role: user.role, enabled: user.enabled, assistantOptIn: user.assistantOptIn, createdAt: user.createdAt };
  } catch {
    return null;
  }
}
