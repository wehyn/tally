import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
const schema = z.object({ membershipId: z.string().uuid(), accept: z.boolean() });
export async function GET() {
  try { const user = await requireUser(); return Response.json({ invitations: getStore().listInvitations(user.id) }); }
  catch (error) { return respondError(error); }
}
export async function PATCH(request: Request) {
  try { assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema); getStore().respondInvitation(user.id, input.membershipId, input.accept); return Response.json({ ok: true }); }
  catch (error) { return respondError(error); }
}
