"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, LayoutDashboard, Send, Settings, Shield, Sparkles, Wallet, X } from "lucide-react";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { PublicUser } from "@/lib/store";
import {
  ASSISTANT_SETTINGS_UPDATED_EVENT,
  assistantAvailabilityFromEvent,
  type AssistantAvailability,
} from "@/lib/client-events";
import { SignOutButton } from "./sign-out-button";
import type { AssistantMode } from "./assistant-widget";

type AssistantPresentation = Exclude<AssistantMode, "closed">;
type AssistantOpening =
  | { kind: "closed" }
  | { kind: "opening"; mode: AssistantPresentation }
  | { kind: "open"; mode: AssistantPresentation };
type AssistantFocusTarget = "launcher" | "close" | "composer" | "none";

function assistantMode(opening: AssistantOpening): AssistantMode {
  return opening.kind === "closed" ? "closed" : opening.mode;
}

function assistantFocusTarget({
  opening,
  previous,
  enabled,
  isMobile,
  restoreComposerFocus,
  busy,
}: {
  opening: AssistantOpening;
  previous: AssistantOpening;
  enabled: boolean;
  isMobile: boolean;
  restoreComposerFocus: boolean;
  busy: boolean;
}): AssistantFocusTarget {
  if (opening.kind === "closed") return previous.kind === "closed" ? "none" : "launcher";
  if (!enabled) return "close";
  if (restoreComposerFocus) return busy ? "none" : "composer";
  if (previous.kind === "opening" && previous.mode === opening.mode) return "none";
  if (opening.mode === "composing" || (opening.mode === "chat" && isMobile)) return "composer";
  if (opening.mode === "chat" && !(previous.kind !== "closed" && previous.mode === "composing")) return "close";
  return "none";
}

const AssistantWidget = dynamic(() => import("./assistant-widget").then((module) => module.AssistantWidget), {
  ssr: false,
  loading: () => <div className="assistant-widget-loading" role="status">Opening Tally assistant…</div>,
});

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
  const [assistantLoaded, setAssistantLoaded] = useState(false);
  const [assistantOpening, setAssistantOpening] = useState<AssistantOpening>({ kind: "closed" });
  const [assistantAccess, setAssistantAccess] = useState<AssistantAvailability>({ enabled: assistantEnabled, configured: assistantConfigured });
  const [assistantHasConversation, setAssistantHasConversation] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantSubmitReady, setAssistantSubmitReady] = useState(false);
  const assistantSubmit = useRef<(() => void) | null>(null);
  const composerField = useRef<HTMLTextAreaElement>(null);
  const launcherButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousAssistantOpening = useRef<AssistantOpening>({ kind: "closed" });
  const restoreComposerFocus = useRef(false);
  const focusHandledByOpen = useRef(false);
  const mode = assistantMode(assistantOpening);
  const panelOpen = mode === "chat" || (!assistantAccess.enabled && mode === "composing");
  const accountEntries = user.role === "admin" ? [...accountNavigation, { href: "/admin", label: "Administration", icon: Shield }] : accountNavigation;
  const pageLabel = [...pageLabels, ...accountEntries].find((item) => active === item.href || active.startsWith(`${item.href}/`))?.label ?? "Home";
  const isCurrentSection = (routes: string[]) => routes.some((route) => active === route || active.startsWith(`${route}/`));
  const accountMenuTrigger = (className: string) => <button type="button" className={`${className} account-menu-trigger`} popoverTarget="account-menu" aria-label={`${user.username} account menu`}><span className="avatar avatar-small" aria-hidden="true">{user.username.slice(0,1).toUpperCase()}</span></button>;

  const handleAssistantAvailability = useCallback((availability: AssistantAvailability) => {
    setAssistantAccess((current) => current.enabled === availability.enabled && current.configured === availability.configured ? current : availability);
  }, []);
  useEffect(() => {
    const updateAssistantAvailability = (event: Event) => {
      const availability = assistantAvailabilityFromEvent(event);
      if (availability) handleAssistantAvailability(availability);
    };
    window.addEventListener(ASSISTANT_SETTINGS_UPDATED_EVENT, updateAssistantAvailability);
    return () => window.removeEventListener(ASSISTANT_SETTINGS_UPDATED_EVENT, updateAssistantAvailability);
  }, [handleAssistantAvailability]);
  const handleAssistantBusy = useCallback((busy: boolean) => setAssistantBusy(busy), []);
  const handleAssistantSubmitReady = useCallback((submit: (() => void) | null) => {
    assistantSubmit.current = submit;
    setAssistantSubmitReady(submit !== null);
  }, []);
  const handleAssistantReady = useCallback(() => {
    setAssistantOpening((current) => current.kind === "opening" ? { kind: "open", mode: current.mode } : current);
  }, []);
  const handleConversationStarted = useCallback(() => {
    setAssistantHasConversation(true);
    setAssistantOpening((current) => current.kind === "closed" ? current : { kind: "open", mode: "chat" });
  }, []);

  const focusAssistant = useCallback((target: AssistantFocusTarget) => {
    if (target === "launcher") launcherButton.current?.focus({ preventScroll: true });
    else if (target === "close") closeButton.current?.focus({ preventScroll: true });
    else if (target === "composer") composerField.current?.focus({ preventScroll: true });
  }, []);

  function openAssistant() {
    const isMobile = window.matchMedia("(max-width: 900px)").matches;
    const nextMode: AssistantPresentation = assistantAccess.enabled && !assistantHasConversation && !isMobile ? "composing" : "chat";
    const nextOpening: AssistantOpening = assistantSubmitReady ? { kind: "open", mode: nextMode } : { kind: "opening", mode: nextMode };
    focusHandledByOpen.current = true;
    flushSync(() => {
      setAssistantOpening(nextOpening);
      setAssistantLoaded(true);
    });
    const target = assistantFocusTarget({
      opening: nextOpening,
      previous: assistantOpening,
      enabled: assistantAccess.enabled,
      isMobile,
      restoreComposerFocus: false,
      busy: assistantBusy,
    });
    focusAssistant(target);
  }

  function closeAssistant() {
    restoreComposerFocus.current = false;
    setAssistantOpening({ kind: "closed" });
  }

  function submitAssistant(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!assistantSubmitReady || assistantBusy || !assistantAccess.enabled || !assistantPrompt.trim()) return;
    restoreComposerFocus.current = true;
    assistantSubmit.current?.();
  }

  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && mode !== "closed") {
      event.preventDefault();
      closeAssistant();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitAssistant();
    }
  }

  useEffect(() => {
    const previous = previousAssistantOpening.current;
    const openingChanged = previous.kind !== assistantOpening.kind || (assistantOpening.kind !== "closed" && previous.kind !== "closed" && previous.mode !== assistantOpening.mode);
    if (focusHandledByOpen.current) focusHandledByOpen.current = false;
    else if (openingChanged || (restoreComposerFocus.current && !assistantBusy)) {
      const target = assistantFocusTarget({
        opening: assistantOpening,
        previous,
        enabled: assistantAccess.enabled,
        isMobile: window.matchMedia("(max-width: 900px)").matches,
        restoreComposerFocus: restoreComposerFocus.current,
        busy: assistantBusy,
      });
      focusAssistant(target);
      if (restoreComposerFocus.current && !assistantBusy) restoreComposerFocus.current = false;
    }
    previousAssistantOpening.current = assistantOpening;
  }, [assistantOpening, assistantAccess.enabled, assistantBusy, focusAssistant]);

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
      <div className={`assistant-widget ${mode}`}>
        <section id="assistant-widget-panel" className={`assistant-widget-panel ${assistantAccess.enabled ? "has-composer" : ""}`} data-open={panelOpen} role="dialog" aria-modal="false" aria-label="Tally assistant" aria-hidden={!panelOpen} inert={!panelOpen} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeAssistant(); } }}>
          <header className="assistant-widget-header">
            <span className="assistant-widget-mark"><Sparkles size={17}/></span>
            <div className="assistant-widget-title"><strong>Ask Tally</strong><span>{assistantAccess.enabled ? "Your private ledger assistant" : "Optional assistant"}</span></div>
            <button ref={closeButton} type="button" className="assistant-widget-icon" aria-label="Close assistant" title="Close" onClick={closeAssistant}><X size={16}/></button>
          </header>
          {assistantLoaded && <AssistantWidget
            enabled={assistantAccess.enabled}
            configured={assistantAccess.configured}
            mode={mode}
            prompt={assistantPrompt}
            onPromptChange={setAssistantPrompt}
            onAvailabilityChange={handleAssistantAvailability}
            onBusyChange={handleAssistantBusy}
            onConversationStarted={handleConversationStarted}
            onReady={handleAssistantReady}
            onSubmitReady={handleAssistantSubmitReady}
          />}
        </section>
        {assistantAccess.enabled ? <form className={`assistant-widget-composer ${mode}`} onSubmit={submitAssistant}>
          <button ref={launcherButton} type="button" className="assistant-widget-mode-button" aria-label={mode === "closed" ? "Open Tally assistant" : "Close message composer"} aria-expanded={panelOpen} aria-controls="assistant-widget-panel" hidden={mode === "chat"} onClick={mode === "closed" ? openAssistant : closeAssistant}>
            {mode === "closed" ? <Sparkles size={19}/> : <X size={16}/>}
          </button>
          <label className="sr-only" htmlFor="assistant-widget-prompt" hidden={mode === "closed"}>Message Tally</label>
          <textarea ref={composerField} id="assistant-widget-prompt" aria-controls="assistant-widget-panel" rows={1} maxLength={2000} value={assistantPrompt} disabled={assistantBusy} hidden={mode === "closed"} onChange={(event) => setAssistantPrompt(event.target.value)} onKeyDown={onPromptKeyDown} placeholder="Ask Tally anything…"/>
          <button className="assistant-widget-send" hidden={mode === "closed"} disabled={assistantBusy || !assistantSubmitReady || !assistantPrompt.trim()} aria-label="Send message" title="Send"><Send size={16}/></button>
        </form> : mode === "closed" ? <button ref={launcherButton} type="button" className="assistant-widget-disabled-trigger" aria-label="Open Tally assistant" aria-expanded={panelOpen} aria-controls="assistant-widget-panel" onClick={openAssistant}><Sparkles size={19}/></button> : null}
      </div>
    </div>
  </div>;
}
