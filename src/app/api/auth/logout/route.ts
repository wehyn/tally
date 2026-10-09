import { assertSameOrigin, respondError } from "@/lib/api";
import { clearSession } from "@/lib/auth";

export async function POST(request: Request) {
  try { assertSameOrigin(request); await clearSession(); return Response.json({ ok: true }); }
  catch (error) { return respondError(error); }
}
