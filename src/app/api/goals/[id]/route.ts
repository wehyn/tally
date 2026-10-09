import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";
const schema = z.object({ name: z.string().trim().min(1).max(100).optional(), target: z.string().max(24).optional(), deadline: z.string().nullable().optional() });
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema);
    getStore().updateGoal(user.id, id, { name: input.name, targetMinor: input.target === undefined ? undefined : parsePHPToMinor(input.target), deadline: input.deadline });
    return Response.json({ goal: getStore().listGoals(user.id).find((goal) => goal.id === id) });
  } catch (error) { return respondError(error); }
}
