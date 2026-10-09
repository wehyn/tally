import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila } from "@/lib/dates";
import { parsePHPToMinor } from "@/lib/money";

const schema = z.object({
  kind: z.enum(["income", "expense", "transfer"]), amount: z.string().max(24), accountId: z.string().uuid(),
  destinationAccountId: z.string().uuid().optional(), categoryId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(180), date: z.string().optional(),
});
export async function GET(request: Request) {
  try {
    const user = await requireUser(); const url = new URL(request.url);
    const start = url.searchParams.get("start") ?? "0000-01-01"; const end = url.searchParams.get("end") ?? "9999-12-31";
    const transactions = getStore().listTransactions(user.id, { start, end }, Number(url.searchParams.get("limit") ?? 100));
    return Response.json({ transactions });
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
