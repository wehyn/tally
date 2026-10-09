import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";
const schema = z.object({ amount: z.string().max(24), note: z.string().max(200).optional(), date: z.string().optional() });
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema);
    const contributionId = getStore().addContribution(user.id, id, { amountMinor: parsePHPToMinor(input.amount), note: input.note, date: input.date ?? (await import("@/lib/dates")).todayInManila() });
    return Response.json({ contributionId }, { status: 201 });
  } catch (error) { return respondError(error); }
}
