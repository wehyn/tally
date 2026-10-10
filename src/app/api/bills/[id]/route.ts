import { z } from "zod";
import { assertSameOrigin, requestJson, requireUser, respondError } from "@/lib/api";
import { todayInManila } from "@/lib/dates";
import { getStore } from "@/lib/db";
import { parsePHPToMinor } from "@/lib/money";
import { BILL_ICONS, isBillIconColor, isBillIconEmoji } from "@/lib/bill-icons";

const iconEmoji = z.string().max(40).refine(isBillIconEmoji, "Choose one valid emoji for the bill icon.");
const iconColor = z.string().refine(isBillIconColor, "Choose a valid six-digit hexadecimal color.");

const schema = z.object({
  expectedNextDueDate: z.string().length(10),
  name: z.string().trim().min(1).max(100).optional(), amount: z.string().max(24).optional(),
  frequency: z.enum(["weekly", "monthly", "yearly"]).optional(), nextDueDate: z.string().length(10).optional(),
  accountId: z.string().min(1).max(100).optional(), categoryId: z.string().min(1).max(100).optional(), icon: z.enum(BILL_ICONS).optional(),
  iconEmoji: iconEmoji.nullable().optional(), iconForegroundColor: iconColor.optional(), iconBackgroundColor: iconColor.optional(),
}).refine((input) => Object.keys(input).some((field) => field !== "expectedNextDueDate"), "At least one bill field is required.");
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const input = await requestJson(request, schema);
    const { amount, expectedNextDueDate, ...fields } = input;
    const store = getStore();
    let bill = store.updateBill(user.id, id, { ...fields, ...(amount === undefined ? {} : { amountMinor: parsePHPToMinor(amount) }) }, expectedNextDueDate);
    const today = todayInManila();
    let postingWarning: string | undefined;
    try {
      const result = store.processDueBills(today);
      if (result.failures.some((failure) => failure.billId === bill.id)) postingWarning = "Bill saved, but its due expense could not be recorded. Tally will retry automatically.";
    } catch (error) {
      console.error("Bill was saved but due expense processing failed.", error);
      if (!bill.archivedAt && bill.nextDueDate <= today) postingWarning = "Bill saved, but its due expense could not be recorded. Tally will retry automatically.";
    }
    try { bill = store.listBills(user.id).find((entry) => entry.id === id) ?? bill; if (bill.archivedAt) postingWarning = undefined; }
    catch (error) { console.error("Could not refresh the saved bill after posting.", error); }
    return Response.json({ bill, ...(postingWarning ? { postingWarning } : {}) });
  } catch (error) { return respondError(error); }
}
