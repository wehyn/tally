import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";
const schema = z.object({ amount: z.string().max(24).optional(), note: z.string().max(200).optional(), date: z.string().optional() });
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema);
    getStore().updateContribution(user.id, id, { amountMinor: input.amount === undefined ? undefined : parsePHPToMinor(input.amount), note: input.note, date: input.date });
    return Response.json({ ok: true });
  } catch (error) { return respondError(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  try { assertSameOrigin(request); const user = await requireUser(); const { id } = await params; getStore().deleteContribution(user.id, id); return Response.json({ ok: true }); }
  catch (error) { return respondError(error); }
}
