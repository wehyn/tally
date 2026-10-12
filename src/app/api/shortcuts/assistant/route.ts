import { HttpError, limiter, requestJson, respondError } from "@/lib/api";
import { assertAssistantAccess, assistantPromptSchema, runAssistantPrompt } from "@/lib/assistant";
import { getStore } from "@/lib/db";
import { hashShortcutCredential } from "@/lib/shortcut-credential";

export async function POST(request: Request) {
  try {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
    if (!bearer) throw new HttpError(401, "Shortcut credential is invalid or revoked.");

    const store = getStore();
    const user = store.findEnabledUserByShortcutCredentialHash(hashShortcutCredential(bearer[1]));
    if (!user) throw new HttpError(401, "Shortcut credential is invalid or revoked.");
    if (!limiter(`shortcut-assistant:${user.id}`, 30, 60_000)) throw new HttpError(429, "Too many Shortcut assistant requests. Try again in a minute.");

    assertAssistantAccess(store, user.id);
    const input = await requestJson(request, assistantPromptSchema);
    const result = await runAssistantPrompt(store, user, input);
    return Response.json({ answer: result.answer, conversationId: result.conversationId });
  } catch (error) {
    return respondError(error);
  }
}
