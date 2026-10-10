import { currentUser } from "@/lib/auth";
import { DebtsView } from "@/components/debts-view";
import { getStore } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DebtsPage() {
  const user = await currentUser();
  if (!user) return null;
  return <DebtsView initial={getStore().listDebts(user.id)} />;
}
