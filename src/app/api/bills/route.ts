import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila } from "@/lib/dates";
import { parsePHPToMinor } from "@/lib/money";
import { BILL_ICONS } from "@/lib/store";

const schema = z.object({
  name: z.string().trim().min(1).max(100), amount: z.string().max(24),
  frequency: z.enum(["weekly", "monthly", "yearly"]), nextDueDate: z.string().length(10),
  accountId: z.string().min(1).max(100), categoryId: z.string().min(1).max(100), icon: z.enum(BILL_ICONS).default("calendar"),
});

export async function GET() {
  try { const user = await requireUser(); return Response.json({ bills: getStore().listBills(user.id) }); }
  catch (error) { return respondError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const input = await requestJson(request, schema);
    const store = getStore();
    let bill = store.createBill(user.id, { name: input.name, amountMinor: parsePHPToMinor(input.amount), frequency: input.frequency, nextDueDate: input.nextDueDate, accountId: input.accountId, categoryId: input.categoryId, icon: input.icon });
    const today = todayInManila();
    let postingWarning: string | undefined;
    try {
      const result = store.processDueBills(today);
      if (result.failures.some((failure) => failure.billId === bill.id)) postingWarning = "Bill saved, but its due expense could not be recorded. Tally will retry automatically.";
    } catch (error) {
      console.error("Bill was saved but due expense processing failed.", error);
      if (!bill.archivedAt && bill.nextDueDate <= today) postingWarning = "Bill saved, but its due expense could not be recorded. Tally will retry automatically.";
    }
    try { bill = store.listBills(user.id).find((entry) => entry.id === bill.id) ?? bill; if (bill.archivedAt) postingWarning = undefined; }
    catch (error) { console.error("Could not refresh the saved bill after posting.", error); }
    return Response.json({ bill, ...(postingWarning ? { postingWarning } : {}) }, { status: 201 });
  } catch (error) { return respondError(error); }
}
