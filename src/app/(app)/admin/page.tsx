import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { AdminView } from "@/components/admin-view";
export const dynamic = "force-dynamic";
export default async function AdminPage(){const user=await currentUser();if(!user)return null;if(user.role!=="admin")redirect("/dashboard");return <AdminView initial={getStore().listUsers().map(({id,username,role,enabled,createdAt})=>({id,username,role,enabled,createdAt}))}/>;}
