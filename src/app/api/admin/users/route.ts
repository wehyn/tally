import { z } from "zod";
import { assertSameOrigin, requireAdmin, requireUser, respondError, requestJson } from "@/lib/api";
import { getStore } from "@/lib/db";
const patchSchema = z.object({ userId: z.string().uuid(), enabled: z.boolean() });
export async function GET() {
  try { const admin = await requireUser(); requireAdmin(admin); return Response.json({ users: getStore().listUsers().map(({ id, username, role, enabled, createdAt }) => ({ id, username, role, enabled, createdAt })) }); }
  catch (error) { return respondError(error); }
}
export async function PATCH(request: Request) {
  try { assertSameOrigin(request); const admin = await requireUser(); requireAdmin(admin); const input = await requestJson(request, patchSchema); getStore().setUserEnabled(admin.id, input.userId, input.enabled); return Response.json({ ok: true }); }
  catch (error) { return respondError(error); }
}
