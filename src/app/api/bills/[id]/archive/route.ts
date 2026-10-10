import { assertSameOrigin, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    getStore().archiveBill(user.id, id);
    return Response.json({ ok: true });
  } catch (error) { return respondError(error); }
}
