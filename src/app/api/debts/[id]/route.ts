import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";

type Context = { params: Promise<{ id: string }> };
const updateSchema = z.object({
  direction: z.enum(["owed_to_you", "you_owe"]).optional(),
  counterparty: z.string().trim().min(1).max(80).optional(),
  amount: z.string().max(24).optional(),
  dueDate: z.string().max(10).nullable().optional(),
  note: z.string().trim().max(500).optional(),
  status: z.enum(["open", "settled"]).optional(),
}).refine((input) => Object.keys(input).length > 0, { message: "Provide at least one debt change." });

export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const input = await requestJson(request, updateSchema);
    const debt = getStore().updateDebt(user.id, id, {
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.counterparty !== undefined ? { counterparty: input.counterparty } : {}),
      ...(input.amount !== undefined ? { amountMinor: parsePHPToMinor(input.amount) } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    return Response.json({ debt });
  } catch (error) {
    return respondError(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    getStore().deleteDebt(user.id, id);
    return Response.json({ ok: true });
  } catch (error) {
    return respondError(error);
  }
}
