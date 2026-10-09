import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
const schema = z.object({ name: z.string().trim().min(1).max(40) });
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Context) {
  try { assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema); getStore().renameCategory(user.id, id, input.name); return Response.json({ ok: true }); }
  catch (error) { return respondError(error); }
}
