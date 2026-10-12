import { randomBytes } from "node:crypto";
import { assertSameOrigin, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { hashShortcutCredential } from "@/lib/shortcut-credential";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const credential = randomBytes(32).toString("base64url");
    getStore().setShortcutCredentialHash(user.id, hashShortcutCredential(credential));
    return Response.json({ credential });
  } catch (error) {
    return respondError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    getStore().setShortcutCredentialHash(user.id, null);
    return Response.json({ revoked: true });
  } catch (error) {
    return respondError(error);
  }
}
