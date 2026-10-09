import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
const schema = z.object({ username: z.string().trim().min(3).max(32) });
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try { assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema); getStore().inviteToGoal(user.id, id, input.username); return Response.json({ ok: true }, { status: 201 }); }
  catch (error) { return respondError(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const memberId = new URL(request.url).searchParams.get("userId");
    if (!memberId) { getStore().changeMembership(user.id, id, user.id, "leave"); return Response.json({ ok: true }); }
    getStore().changeMembership(user.id, id, memberId, "remove"); return Response.json({ ok: true });
  } catch (error) { return respondError(error); }
}
