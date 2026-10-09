import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { TransactionsView } from "@/components/transactions-view";
export const dynamic = "force-dynamic";
export default async function TransactionsPage(){const user=await currentUser();if(!user)return null;const store=getStore();return <TransactionsView initial={store.listTransactions(user.id)} initialAccounts={store.listAccounts(user.id)} initialCategories={store.listCategories(user.id)}/>;}
