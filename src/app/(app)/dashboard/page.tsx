import { getStore } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { monthToDateRange } from "@/lib/dates";
import { calendarActivityFromDashboard, calendarMonthFromDate, calendarMonthView } from "@/lib/dashboard-calendar";
import { DashboardView } from "@/components/dashboard-view";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const user = await currentUser(); if (!user) return null;
  const now = new Date(); const range = monthToDateRange(now); const store = getStore();
  const initial = store.getDashboard(user.id, range.start, range.end);
  const month = calendarMonthFromDate(range.start); const monthView = calendarMonthView(month);
  const activity = calendarActivityFromDashboard(store.getDashboard(user.id, monthView.start, monthView.end), monthView);
  return <DashboardView initial={initial} initialCalendar={{ month, activity }}/>;
}
