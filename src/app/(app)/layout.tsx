import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
export default async function PrivateLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <AppShell user={user}>{children}</AppShell>;
}
