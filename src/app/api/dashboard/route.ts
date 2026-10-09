import { requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { isDateOnly, monthToDateRange } from "@/lib/dates";
export async function GET(request: Request) {
  try {
    const user = await requireUser(); const url = new URL(request.url); const month = monthToDateRange();
    const start = url.searchParams.get("start") ?? month.start; const end = url.searchParams.get("end") ?? month.end;
    if (!isDateOnly(start) || !isDateOnly(end) || start > end) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    return Response.json(getStore().getDashboard(user.id, start, end));
  } catch (error) { return respondError(error); }
}
