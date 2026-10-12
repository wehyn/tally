"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, LayoutDashboard, Settings, Shield, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { PublicUser } from "@/lib/store";
import { SignOutButton } from "./sign-out-button";
import { AssistantWidget } from "./assistant-widget";

const navigation = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard, routes: ["/dashboard"] },
  { href: "/money", label: "Money", icon: Wallet, routes: ["/money", "/transactions", "/accounts"] },
  { href: "/plan", label: "Plan", icon: CalendarDays, routes: ["/plan", "/bills", "/debts", "/goals"] },
];
const pageLabels = [
  { href: "/dashboard", label: "Home" },
  { href: "/money", label: "Money" },
  { href: "/transactions", label: "Transactions" },
  { href: "/accounts", label: "Accounts" },
  { href: "/plan", label: "Plan" },
  { href: "/bills", label: "Bills" },
  { href: "/debts", label: "Debts" },
  { href: "/goals", label: "Shared goals" },
];
const accountNavigation = [{ href: "/settings", label: "Settings", icon: Settings }];
export function AppShell({ user, children, assistantEnabled, assistantConfigured }: { user: PublicUser; children: ReactNode; assistantEnabled: boolean; assistantConfigured: boolean }) {
  const active = usePathname();
  const accountEntries = user.role === "admin" ? [...accountNavigation, { href: "/admin", label: "Administration", icon: Shield }] : accountNavigation;
  const pageLabel = [...pageLabels, ...accountEntries].find((item) => active === item.href || active.startsWith(`${item.href}/`))?.label ?? "Home";
  const isCurrentSection = (routes: string[]) => routes.some((route) => active === route || active.startsWith(`${route}/`));
  const accountMenuTrigger = (className: string) => <button type="button" className={`${className} account-menu-trigger`} popoverTarget="account-menu" aria-label={`${user.username} account menu`}><span className="avatar avatar-small" aria-hidden="true">{user.username.slice(0,1).toUpperCase()}</span></button>;
  return <div className={`app-frame ${active === "/debts" ? "debts-shell" : ""}`}>
    <aside className="sidebar">
      <Link href="/dashboard" className="brand"><span className="brand-mark">t</span><span>Tally</span></Link>
      <div className="nav-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {navigation.map(({ href, label, icon: Icon, routes }) => {
          const selected = isCurrentSection(routes);
          return <Link href={href} className={`nav-item ${selected ? "active" : ""}`} key={href} aria-current={active === href ? "page" : selected ? "location" : undefined}><Icon size={18} strokeWidth={1.8}/><span>{label}</span></Link>;
        })}
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-note"><span className="privacy-dot"/>Private by default</div>
      <div className="sidebar-user">{accountMenuTrigger("sidebar-account-trigger")}<div className="user-lines"><strong>{user.username}</strong><span>{user.role === "admin" ? "Administrator" : "Personal ledger"}</span></div><SignOutButton/></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{pageLabel}</strong></div></header>
      {accountMenuTrigger("mobile-account-trigger")}
      <div id="account-menu" className="account-menu-panel" popover="auto">
        <div className="account-menu-heading"><strong>{user.username}</strong><span>{user.role === "admin" ? "Administrator" : "Personal ledger"}</span></div>
        <nav className="account-menu-links" aria-label="Account navigation">
          {accountEntries.map(({ href, label, icon: Icon }) => <Link href={href} className="account-menu-link" key={href} aria-current={active === href ? "page" : undefined} onNavigate={() => document.getElementById("account-menu")?.hidePopover()}><Icon size={16} aria-hidden="true"/><span>{label}</span></Link>)}
        </nav>
      </div>
      <main className="page-content">{children}</main>
    </div>
    <div className="mobile-controls">
      <nav className="mobile-nav" aria-label="Mobile navigation">{navigation.map(({ href, label, icon: Icon, routes }) => {
        const selected = isCurrentSection(routes);
        return <Link key={href} href={href} className={selected ? "selected" : ""} aria-label={label} aria-current={active === href ? "page" : selected ? "location" : undefined}><Icon size={19} aria-hidden="true"/><span>{label}</span></Link>;
      })}</nav>
      <AssistantWidget enabled={assistantEnabled} configured={assistantConfigured} />
    </div>
  </div>;
}
