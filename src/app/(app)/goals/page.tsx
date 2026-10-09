import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { GoalsView, type GoalView, type InvitationView } from "@/components/goals-view";
export const dynamic = "force-dynamic";
export default async function GoalsPage(){const user=await currentUser();if(!user)return null;const store=getStore();return <GoalsView userId={user.id} initialGoals={store.listGoals(user.id) as unknown as GoalView[]} initialInvitations={store.listInvitations(user.id) as unknown as InvitationView[]}/>;}
