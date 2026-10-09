import { currentUser } from "@/lib/auth";
import { SettingsView } from "@/components/settings-view";
export const dynamic = "force-dynamic";
export default async function SettingsPage(){const user=await currentUser();if(!user)return null;return <SettingsView user={{id:user.id,role:user.role}}/>;}
