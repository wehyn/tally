import { getStore } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { monthToDateRange } from "@/lib/dates";
import { calendarActivityFromDashboard, calendarMonthFromDate, calendarMonthView } from "@/lib/dashboard-calendar";
import { todayInManila } from "@/lib/dates";
import { DashboardView } from "@/components/dashboard-view";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const user = await currentUser(); if (!user) return null;
  const now = new Date(); const range = monthToDateRange(now); const store = getStore();
  const initial = store.getDashboard(user.id, range.start, range.end);
  const month = calendarMonthFromDate(range.start); const monthView = calendarMonthView(month);
  const activity = calendarActivityFromDashboard(store.getDashboard(user.id, monthView.start, monthView.end), monthView);
  const today = todayInManila(now);
  const upcomingBills = store.listBills(user.id).filter((bill) => !bill.archivedAt && bill.nextDueDate >= today).slice(0, 3)
    .map(({ id, name, amountMinor, nextDueDate }) => ({ id, name, amountMinor, nextDueDate }));
  const openDebts = store.listDebts(user.id).filter((debt) => debt.status === "open");
  const sumDebts = (direction: string) => openDebts.filter((debt) => debt.direction === direction).reduce((total, debt) => total + debt.amountMinor, 0);
  return <DashboardView initial={initial} initialCalendar={{ month, activity }} upcomingBills={upcomingBills} debtSummary={{ owedToYouMinor: sumDebts("owed_to_you"), youOweMinor: sumDebts("you_owe") }}/>;
}
