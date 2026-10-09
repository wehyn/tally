"use client";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
export function SignOutButton() {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function signOut() { setBusy(true); await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); }
  return <button className="icon-button signout" aria-label="Sign out" title="Sign out" disabled={busy} onClick={signOut}><LogOut size={16}/></button>;
}
