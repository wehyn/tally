import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";

const schema = z.object({ name: z.string().trim().min(1).max(80).optional(), type: z.enum(["cash", "bank"]).optional(), openingBalance: z.string().max(24).optional() });
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema);
    getStore().updateAccount(user.id, id, { name: input.name, type: input.type, openingMinor: input.openingBalance === undefined ? undefined : parsePHPToMinor(input.openingBalance, { allowZero: true }) });
    return Response.json({ account: getStore().listAccounts(user.id).find((account) => account.id === id) });
  } catch (error) { return respondError(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  try { assertSameOrigin(request); const user = await requireUser(); const { id } = await params; getStore().deleteAccount(user.id, id); return Response.json({ ok: true }); }
  catch (error) { return respondError(error); }
}
