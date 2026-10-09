import { createHash, randomBytes } from "node:crypto";
import { assertSameOrigin, requireAdmin, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const admin = await requireUser(); requireAdmin(admin); const { id } = await params;
    const user = getStore().getUserById(id);
    if (!user || !user.enabled) return Response.json({ error: "Enabled user not found." }, { status: 404 });
    const token = randomBytes(32).toString("base64url");
    getStore().setResetCredential(id, createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 15 * 60_000).toISOString());
    return Response.json({ resetToken: token, expiresInMinutes: 15 });
  } catch (error) { return respondError(error); }
}
