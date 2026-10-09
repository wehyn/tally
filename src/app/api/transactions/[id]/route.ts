import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila } from "@/lib/dates";
import { parsePHPToMinor } from "@/lib/money";
const schema = z.object({ kind: z.enum(["income", "expense", "transfer"]), amount: z.string().max(24), accountId: z.string().uuid(), destinationAccountId: z.string().uuid().optional(), categoryId: z.string().uuid().optional(), description: z.string().trim().min(1).max(180), date: z.string().optional() });
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema);
    const transaction = getStore().updateTransaction(user.id, id, { kind: input.kind, amountMinor: parsePHPToMinor(input.amount), accountId: input.accountId, destinationAccountId: input.destinationAccountId, categoryId: input.categoryId, description: input.description, date: input.date ?? todayInManila() });
    return Response.json({ transaction });
  } catch (error) { return respondError(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params;
    getStore().deleteTransaction(user.id, id, new URL(request.url).searchParams.get("undo") === "1");
    return Response.json({ ok: true });
  } catch (error) { return respondError(error); }
}
