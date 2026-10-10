import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { BillsView } from "@/components/bills-view";

export const dynamic = "force-dynamic";
export default async function BillsPage() {
  const user = await currentUser();
  if (!user) return null;
  const store = getStore();
  return <BillsView initialBills={store.listBills(user.id)} accounts={store.listAccounts(user.id)} categories={store.listCategories(user.id).filter((category) => category.type === "expense")} />;
}
