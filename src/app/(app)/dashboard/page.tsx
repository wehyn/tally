import { getStore } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { monthToDateRange } from "@/lib/dates";
import { DashboardView } from "@/components/dashboard-view";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const user = await currentUser(); if (!user) return null;
  const range = monthToDateRange(); const store = getStore();
  return <DashboardView initial={store.getDashboard(user.id, range.start, range.end)}/>;
}
