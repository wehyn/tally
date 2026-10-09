import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
const schema = z.object({ title: z.string().trim().max(120).optional() });
export async function GET(request: Request) {
  try {
    const user = await requireUser(); const store = getStore(); const id = new URL(request.url).searchParams.get("id");
    return Response.json(id ? { conversation: store.getConversation(user.id, id) } : { conversations: store.listConversations(user.id) });
  } catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema); const id = getStore().createConversation(user.id, input.title || "New conversation"); return Response.json({ id }, { status: 201 }); }
  catch (error) { return respondError(error); }
}
