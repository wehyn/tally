import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila } from "@/lib/dates";
import { parsePHPToMinor } from "@/lib/money";
import type { TransactionKind } from "@/lib/store";

const schema = z.object({
  kind: z.enum(["income", "expense", "transfer"]), amount: z.string().max(24), accountId: z.string().uuid(),
  destinationAccountId: z.string().uuid().optional(), categoryId: z.string().uuid().optional(),
  description: z.string().trim().max(180).optional().default(""), date: z.string().optional(),
});
export async function GET(request: Request) {
  try {
    const user = await requireUser(); const url = new URL(request.url);
    const start = url.searchParams.get("start") ?? "0000-01-01"; const end = url.searchParams.get("end") ?? "9999-12-31";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 100;
    const requestedOffset = Number(url.searchParams.get("offset") ?? 0);
    const offset = Number.isSafeInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    const requestedKind = url.searchParams.get("kind");
    const kind: TransactionKind | undefined = requestedKind === "income" || requestedKind === "expense" || requestedKind === "transfer" ? requestedKind : undefined;
    const fetched = getStore().listTransactions(user.id, { start, end }, limit + 1, { kind, offset });
    return Response.json({ transactions: fetched.slice(0, limit), hasMore: fetched.length > limit });
  } catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const input = await requestJson(request, schema);
    const transaction = getStore().createTransaction(user.id, {
      kind: input.kind, amountMinor: parsePHPToMinor(input.amount), accountId: input.accountId,
      destinationAccountId: input.destinationAccountId, categoryId: input.categoryId,
      description: input.description, date: input.date ?? todayInManila(), source: "manual",
    });
    return Response.json({ transaction }, { status: 201 });
  } catch (error) { return respondError(error); }
}
