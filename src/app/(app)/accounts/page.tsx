import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { AccountsView } from "@/components/accounts-view";
export const dynamic = "force-dynamic";
export default async function AccountsPage(){const user=await currentUser();if(!user)return null;const store=getStore();const transferPage=store.listTransactions(user.id,undefined,101,{kind:"transfer"});return <AccountsView initial={store.listAccounts(user.id)} initialTransfers={transferPage.slice(0,100)} initialHasMoreTransfers={transferPage.length>100}/>;}
