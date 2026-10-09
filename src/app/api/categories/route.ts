import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
const schema = z.object({ name: z.string().trim().min(1).max(40), type: z.enum(["income", "expense"]) });
export async function GET() {
  try { const user = await requireUser(); return Response.json({ categories: getStore().listCategories(user.id) }); }
  catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema); return Response.json({ category: getStore().createCategory(user.id, input) }, { status: 201 }); }
  catch (error) { return respondError(error); }
}
