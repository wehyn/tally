import { compare } from "bcryptjs";
import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { clearSession } from "@/lib/auth";
import { getStore } from "@/lib/db";
const schema = z.object({ password: z.string().min(1).max(128), adminHandoffTo: z.string().uuid().optional() });
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema);
    const full = getStore().getUserById(user.id);
    if (!full || !(await compare(input.password, full.passwordHash))) return Response.json({ error: "Password is incorrect." }, { status: 400 });
    getStore().deleteAccountOwner(user.id, input.adminHandoffTo);
    await clearSession();
    return Response.json({ ok: true });
  } catch (error) { return respondError(error); }
}
