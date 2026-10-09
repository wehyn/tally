import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { providerDisclosureHash, providerPublicConfig } from "@/lib/provider";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
export default async function PrivateLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const disclosureHash = providerDisclosureHash();
  const provider = providerPublicConfig();
  const assistantEnabled = Boolean(disclosureHash && provider.configured && getStore().getAssistantOptIn(user.id, disclosureHash));
  return <AppShell user={user} assistantEnabled={assistantEnabled} assistantConfigured={provider.configured}>{children}</AppShell>;
}
