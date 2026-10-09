import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { providerDisclosureHash, providerPublicConfig } from "@/lib/provider";
import { AssistantView, type ChatData, type Conversation } from "@/components/assistant-view";
export const dynamic = "force-dynamic";
export default async function AssistantPage(){const user=await currentUser();if(!user)return null;const store=getStore();const conversations=store.listConversations(user.id) as Conversation[];const initialChat=conversations[0]?store.getConversation(user.id,conversations[0].id) as ChatData|null:null;const disclosureHash=providerDisclosureHash();const provider=providerPublicConfig();return <AssistantView initialConversations={conversations} initialChat={initialChat} enabled={Boolean(disclosureHash&&provider.configured&&store.getAssistantOptIn(user.id,disclosureHash))} configured={provider.configured}/>;}
