import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
const schema = z.object({ name: z.string().trim().min(1).max(100), target: z.string().max(24), deadline: z.string().optional() });
export async function GET() {
  try { const user = await requireUser(); const store = getStore(); return Response.json({ goals: store.listGoals(user.id), invitations: store.listInvitations(user.id) }); }
  catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema);
    const id = getStore().createGoal(user.id, { name: input.name, targetMinor: (await import("@/lib/money")).parsePHPToMinor(input.target), deadline: input.deadline || undefined });
    return Response.json({ id }, { status: 201 });
  } catch (error) { return respondError(error); }
}
