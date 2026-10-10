"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, HandCoins, LayoutDashboard, Settings, Shield, Target, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { PublicUser } from "@/lib/store";
import { SignOutButton } from "./sign-out-button";
import { AssistantWidget } from "./assistant-widget";

const navigation = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/accounts", label: "Accounts", icon: Wallet },
  { href: "/debts", label: "Debts", icon: HandCoins },
  { href: "/goals", label: "Shared goals", icon: Target },
  { href: "/settings", label: "Settings", icon: Settings },
];
export function AppShell({ user, children, assistantEnabled, assistantConfigured }: { user: PublicUser; children: ReactNode; assistantEnabled: boolean; assistantConfigured: boolean }) {
  const active = usePathname();
  const entries = user.role === "admin" ? [...navigation, { href: "/admin", label: "Administration", icon: Shield }] : navigation;
  const mobileEntries = entries.filter(({ href }) => href !== "/admin");
  return <div className={`app-frame ${active === "/debts" ? "debts-shell" : ""}`}>
    <aside className="sidebar">
      <Link href="/dashboard" className="brand"><span className="brand-mark">t</span><span>Tally</span></Link>
      <div className="nav-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {entries.map(({ href, label, icon: Icon }) => <Link href={href} className={`nav-item ${active === href ? "active" : ""}`} key={href} aria-current={active === href ? "page" : undefined}><Icon size={18} strokeWidth={1.8}/><span>{label}</span></Link>)}
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-note"><span className="privacy-dot"/>Private by default</div>
      <div className="sidebar-user"><div className="avatar">{user.username.slice(0,1).toUpperCase()}</div><div className="user-lines"><strong>{user.username}</strong><span>{user.role === "admin" ? "Administrator" : "Personal ledger"}</span></div><SignOutButton/></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="mobile-brand"><span className="brand-mark">t</span><span>Tally</span></div><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{entries.find((item) => item.href === active)?.label ?? "Overview"}</strong></div><div className="topbar-right"><span className="today-chip">PHP · Asia/Manila</span><div className="avatar avatar-small">{user.username.slice(0,1).toUpperCase()}</div></div></header>
      <main className="page-content">{children}</main>
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">{mobileEntries.map(({href,label,icon:Icon})=><Link key={href} href={href} className={active===href?"selected":""} aria-label={label} aria-current={active===href?"page":undefined}><Icon size={20}/><span>{label === "Overview" ? "Home" : label === "Transactions" ? "Ledger" : label === "Shared goals" ? "Goals" : label}</span></Link>)}</nav>
    <AssistantWidget enabled={assistantEnabled} configured={assistantConfigured} />
  </div>;
}
