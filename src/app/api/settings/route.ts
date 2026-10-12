import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { providerDisclosureHash, providerPublicConfig, providerConfig } from "@/lib/provider";
const schema = z.object({ assistantOptIn: z.boolean(), confirmedDisclosureHash: z.string().optional() });
export async function GET() {
  try { const user = await requireUser(); const disclosureHash = providerDisclosureHash(); const store = getStore(); return Response.json({ assistantOptIn: disclosureHash ? store.getAssistantOptIn(user.id, disclosureHash) : false, provider: providerPublicConfig(), disclosureHash, shortcutCredentialActive: store.hasShortcutCredential(user.id) }); }
  catch (error) { return respondError(error); }
}
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema);
    const disclosureHash = providerDisclosureHash();
    if (input.assistantOptIn && (!providerConfig() || !disclosureHash || input.confirmedDisclosureHash !== disclosureHash)) return Response.json({ error: "Review the current provider disclosure and confirm it before enabling the assistant." }, { status: 400 });
    getStore().setAssistantConsent(user.id, input.assistantOptIn ? disclosureHash : null);
    return Response.json({ assistantOptIn: input.assistantOptIn });
  } catch (error) { return respondError(error); }
}
