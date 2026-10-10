import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";

const debtSchema = z.object({
  direction: z.enum(["owed_to_you", "you_owe"]),
  counterparty: z.string().trim().min(1).max(80),
  amount: z.string().max(24),
  dueDate: z.string().max(10).nullable().optional(),
  note: z.string().trim().max(500).optional().default(""),
});

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ debts: getStore().listDebts(user.id) });
  } catch (error) {
    return respondError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const input = await requestJson(request, debtSchema);
    const debt = getStore().createDebt(user.id, {
      direction: input.direction,
      counterparty: input.counterparty,
      amountMinor: parsePHPToMinor(input.amount),
      dueDate: input.dueDate,
      note: input.note,
    });
    return Response.json({ debt }, { status: 201 });
  } catch (error) {
    return respondError(error);
  }
}
