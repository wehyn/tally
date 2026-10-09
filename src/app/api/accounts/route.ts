import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";

const schema = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(["cash", "bank"]), openingBalance: z.string().max(24).default("0") });
export async function GET() {
  try { const user = await requireUser(); return Response.json({ accounts: getStore().listAccounts(user.id) }); }
  catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema);
    const account = getStore().createAccount(user.id, { name: input.name, type: input.type, openingMinor: parsePHPToMinor(input.openingBalance, { allowZero: true }) });
    return Response.json({ account }, { status: 201 });
  } catch (error) { return respondError(error); }
}
