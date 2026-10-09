import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { AccountsView } from "@/components/accounts-view";
export const dynamic = "force-dynamic";
export default async function AccountsPage(){const user=await currentUser();if(!user)return null;return <AccountsView initial={getStore().listAccounts(user.id)}/>;}
