"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, CalendarDays, ChevronDown, HandCoins, LayoutDashboard, Settings, Shield, Target, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { PublicUser } from "@/lib/store";
import { SignOutButton } from "./sign-out-button";
import { AssistantWidget } from "./assistant-widget";

const navigation = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/accounts", label: "Accounts", icon: Wallet },
  { href: "/bills", label: "Bills", icon: CalendarDays },
  { href: "/debts", label: "Debts", icon: HandCoins },
  { href: "/goals", label: "Shared goals", icon: Target },
];
const accountNavigation = [{ href: "/settings", label: "Settings", icon: Settings }];
export function AppShell({ user, children, assistantEnabled, assistantConfigured }: { user: PublicUser; children: ReactNode; assistantEnabled: boolean; assistantConfigured: boolean }) {
  const active = usePathname();
  const accountEntries = user.role === "admin" ? [...accountNavigation, { href: "/admin", label: "Administration", icon: Shield }] : accountNavigation;
  const pageLabel = [...navigation, ...accountEntries].find((item) => item.href === active)?.label ?? "Overview";
  return <div className={`app-frame ${active === "/debts" ? "debts-shell" : ""}`}>
    <aside className="sidebar">
      <Link href="/dashboard" className="brand"><span className="brand-mark">t</span><span>Tally</span></Link>
      <div className="nav-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {navigation.map(({ href, label, icon: Icon }) => <Link href={href} className={`nav-item ${active === href ? "active" : ""}`} key={href} aria-current={active === href ? "page" : undefined}><Icon size={18} strokeWidth={1.8}/><span>{label}</span></Link>)}
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-note"><span className="privacy-dot"/>Private by default</div>
      <div className="sidebar-user"><div className="avatar">{user.username.slice(0,1).toUpperCase()}</div><div className="user-lines"><strong>{user.username}</strong><span>{user.role === "admin" ? "Administrator" : "Personal ledger"}</span></div><SignOutButton/></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="mobile-brand"><span className="brand-mark">t</span><span>Tally</span></div><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{pageLabel}</strong></div><div className="topbar-right"><span className="today-chip">PHP · Asia/Manila</span><button type="button" className="account-menu-trigger" popoverTarget="account-menu" aria-label={`${user.username} account menu`}><span className="avatar avatar-small" aria-hidden="true">{user.username.slice(0,1).toUpperCase()}</span><ChevronDown size={13} aria-hidden="true"/></button></div></header>
      <div id="account-menu" className="account-menu-panel" popover="auto">
        <div className="account-menu-heading"><strong>{user.username}</strong><span>{user.role === "admin" ? "Administrator" : "Personal ledger"}</span></div>
        <nav className="account-menu-links" aria-label="Account navigation">
          {accountEntries.map(({ href, label, icon: Icon }) => <Link href={href} className="account-menu-link" key={href} aria-current={active === href ? "page" : undefined} onNavigate={() => document.getElementById("account-menu")?.hidePopover()}><Icon size={16} aria-hidden="true"/><span>{label}</span></Link>)}
        </nav>
      </div>
      <main className="page-content">{children}</main>
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">{navigation.map(({href,label,icon:Icon})=><Link key={href} href={href} className={active===href?"selected":""} aria-label={label} aria-current={active===href?"page":undefined}><Icon size={20}/></Link>)}</nav>
    <AssistantWidget enabled={assistantEnabled} configured={assistantConfigured} />
  </div>;
}
