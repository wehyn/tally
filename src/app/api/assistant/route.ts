import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { assertAssistantAccess, assistantPromptSchema, runAssistantPrompt } from "@/lib/assistant";
import { getStore } from "@/lib/db";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const store = getStore();
    assertAssistantAccess(store, user.id);
    const input = await requestJson(request, assistantPromptSchema);
    return Response.json(await runAssistantPrompt(store, user, input));
  } catch (error) {
    return respondError(error);
  }
}
