import { getStore } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { monthToDateRange } from "@/lib/dates";
import { providerDisclosureHash, providerPublicConfig } from "@/lib/provider";
import { DashboardView } from "@/components/dashboard-view";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const user = await currentUser(); if (!user) return null;
  const range = monthToDateRange(); const store = getStore();
  const disclosureHash = providerDisclosureHash(); const provider = providerPublicConfig();
  const assistantEnabled = Boolean(disclosureHash && provider.configured && store.getAssistantOptIn(user.id, disclosureHash));
  return <DashboardView initial={store.getDashboard(user.id, range.start, range.end)} categories={store.listCategories(user.id)} assistantEnabled={assistantEnabled}/>;
}
