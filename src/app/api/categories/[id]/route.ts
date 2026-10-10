import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { CATEGORY_ICON_IDS } from "@/lib/category-icons";
import { getStore } from "@/lib/db";
const schema = z.object({ name: z.string().trim().min(1).max(40).optional(), icon: z.enum(CATEGORY_ICON_IDS).optional() })
  .refine((input) => input.name !== undefined || input.icon !== undefined, "Choose a name or icon to update.");
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Context) {
  try { assertSameOrigin(request); const user = await requireUser(); const { id } = await params; const input = await requestJson(request, schema); return Response.json({ category: getStore().updateCategory(user.id, id, input) }); }
  catch (error) { return respondError(error); }
}
