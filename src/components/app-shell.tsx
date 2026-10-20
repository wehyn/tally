"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, CalendarDays, HandCoins, House, Plus, Receipt, Send, Settings, Shield, Sparkles, Target, Wallet, X, type LucideIcon } from "lucide-react";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { PublicUser } from "@/lib/store";
import { ADD_INTENT_EVENT, ADD_INTENT_PARAM, type AddIntent } from "@/lib/add-intent";
import {
  ASSISTANT_SETTINGS_UPDATED_EVENT,
  assistantAvailabilityFromEvent,
  type AssistantAvailability,
} from "@/lib/client-events";
import { SignOutButton } from "./sign-out-button";
import type { AssistantMode } from "./assistant-widget";

type AssistantPresentation = Exclude<AssistantMode, "closed">;
type RouteEntrySnapshot = { pathname: string; cards: HTMLElement[] };
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
  { href: "/dashboard", label: "Home", icon: House, routes: ["/dashboard"] },
  { href: "/money", label: "Money", icon: Wallet, routes: ["/money", "/transactions", "/accounts"] },
  { href: "/plan", label: "Plan", icon: CalendarDays, routes: ["/plan", "/bills", "/debts", "/goals"] },
];
const addActions: { intent: AddIntent; href: string; label: string; detail: string; icon: LucideIcon; tone: string }[] = [
  { intent: "transaction", href: "/transactions", label: "Income or expense", detail: "Log money in or out", icon: Receipt, tone: "lime" },
  { intent: "transfer", href: "/accounts", label: "Transfer", detail: "Move between accounts", icon: ArrowLeftRight, tone: "sky" },
  { intent: "bill", href: "/bills", label: "Bill", detail: "Track a due date", icon: CalendarDays, tone: "coral" },
  { intent: "debt", href: "/debts", label: "Debt", detail: "Money owed either way", icon: HandCoins, tone: "sand" },
  { intent: "goal", href: "/goals", label: "Shared goal", detail: "Save toward something", icon: Target, tone: "lilac" },
];
const accountNavigation = [{ href: "/settings", label: "Settings", icon: Settings }];
const PAGE_CARD_SELECTOR = ".page-stack .panel, .page-stack .stat-card, .page-stack .account-card, .page-stack .goal-card, .page-stack .admin-card, .page-stack .debt-summary-card, .page-stack .section-destination";
const PAGE_CARD_EXCLUSION_SELECTOR = ".archived-disclosure, .category-manager-collapsible, .modal-backdrop, .modal-card";

function usePageCardEntry(pathname: string): RefObject<HTMLElement | null> {
  const pageContentRef = useRef<HTMLElement>(null);
  const activeAnimations = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const pageContent = pageContentRef.current;
    if (!pageContent) return;

    const cards = Array.from(pageContent.querySelectorAll<HTMLElement>(PAGE_CARD_SELECTOR)).filter((card) => {
      const ancestorCard = card.parentElement?.closest(PAGE_CARD_SELECTOR);
      return card.getClientRects().length > 0
        && getComputedStyle(card).visibility !== "hidden"
        && !card.closest(PAGE_CARD_EXCLUSION_SELECTOR)
        && !(ancestorCard && pageContent.contains(ancestorCard));
    });
    const snapshot: RouteEntrySnapshot = { pathname, cards };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof Element.prototype.animate !== "function") return;

    activeAnimations.current = snapshot.cards.map((card, index) => card.animate([
      { opacity: 0.88, transform: "translateY(5px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], {
      duration: 220,
      delay: Math.min(index * 28, 112),
      easing: "cubic-bezier(.22,.8,.2,1)",
      fill: "backwards",
    }));

    return () => {
      activeAnimations.current.forEach((animation) => animation.cancel());
      activeAnimations.current = [];
    };
  }, [pathname]);

  return pageContentRef;
}

export function AppShell({ user, children, assistantEnabled, assistantConfigured }: { user: PublicUser; children: ReactNode; assistantEnabled: boolean; assistantConfigured: boolean }) {
  const active = usePathname();
  const pageContentRef = usePageCardEntry(active);
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
  const isCurrentSection = (routes: string[]) => routes.some((route) => active === route || active.startsWith(`${route}/`));
  const hidePopover = (id: string) => document.getElementById(id)?.hidePopover();
  const startAdd = (event: MouseEvent<HTMLAnchorElement>, action: (typeof addActions)[number]) => {
    if (active === action.href) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(ADD_INTENT_EVENT, { detail: action.intent }));
    }
    hidePopover("add-sheet");
  };

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
    <header className="topbar">
      <Link href="/dashboard" className="brand"><span className="brand-mark">t</span><span>tally</span></Link>
      <button type="button" className="account-menu-trigger" popoverTarget="account-menu" aria-label={`${user.username} account menu`}><span className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span></button>
    </header>
    <div id="account-menu" className="account-menu-panel" popover="auto">
      <div className="account-menu-heading"><strong>{user.username}</strong><span>{user.role === "admin" ? "Administrator" : "Personal ledger"}</span></div>
      <nav className="account-menu-links" aria-label="Account navigation">
        {accountEntries.map(({ href, label, icon: Icon }) => <Link href={href} className="account-menu-link" key={href} aria-current={active === href ? "page" : undefined} onNavigate={() => hidePopover("account-menu")}><Icon size={16} aria-hidden="true"/><span>{label}</span></Link>)}
      </nav>
      <div className="account-menu-footer"><SignOutButton/><span>Sign out</span></div>
    </div>
    <div id="add-sheet" className="add-sheet" popover="auto" aria-label="Create new">
      <div className="add-sheet-heading"><strong>Add something</strong><button type="button" className="icon-button" aria-label="Close" popoverTarget="add-sheet" popoverTargetAction="hide"><X size={16}/></button></div>
      <div className="add-sheet-grid">
        {addActions.map((action) => <Link key={action.intent} href={`${action.href}?${ADD_INTENT_PARAM}=${action.intent}`} className={`add-sheet-item ${action.tone}`} onClick={(event) => startAdd(event, action)}><span className="add-sheet-icon"><action.icon size={18} aria-hidden="true"/></span><strong>{action.label}</strong><span>{action.detail}</span></Link>)}
      </div>
    </div>
    <main ref={pageContentRef} className="page-content">{children}</main>
    <div className="mobile-controls">
      <nav className="dock" aria-label="Main navigation">
        {navigation.slice(0, 2).map(({ href, label, icon: Icon, routes }) => {
          const selected = isCurrentSection(routes);
          return <Link key={href} href={href} className={`dock-item ${selected ? "selected" : ""}`} aria-label={label} aria-current={active === href ? "page" : selected ? "location" : undefined}><Icon size={19} aria-hidden="true"/><span>{label}</span></Link>;
        })}
        <button type="button" className="dock-add" popoverTarget="add-sheet" aria-label="Add something"><Plus size={22} strokeWidth={2.4} aria-hidden="true"/></button>
        {navigation.slice(2).map(({ href, label, icon: Icon, routes }) => {
          const selected = isCurrentSection(routes);
          return <Link key={href} href={href} className={`dock-item ${selected ? "selected" : ""}`} aria-label={label} aria-current={active === href ? "page" : selected ? "location" : undefined}><Icon size={19} aria-hidden="true"/><span>{label}</span></Link>;
        })}
        <button ref={launcherButton} type="button" className={`dock-item dock-ask ${mode === "closed" ? "" : "selected"}`} aria-label={mode === "closed" ? "Open Tally assistant" : "Close Tally assistant"} aria-expanded={panelOpen} aria-controls="assistant-widget-panel" onClick={mode === "closed" ? openAssistant : closeAssistant}><Sparkles size={19} aria-hidden="true"/><span>Ask</span></button>
      </nav>
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
        {assistantAccess.enabled ? <form className={`assistant-widget-composer ${mode}`} hidden={mode === "closed"} onSubmit={submitAssistant}>
          <button type="button" className="assistant-widget-mode-button" aria-label="Close message composer" aria-expanded={panelOpen} aria-controls="assistant-widget-panel" hidden={mode === "chat"} onClick={closeAssistant}>
            <X size={16}/>
          </button>
          <label className="sr-only" htmlFor="assistant-widget-prompt" hidden={mode === "closed"}>Message Tally</label>
          <textarea ref={composerField} id="assistant-widget-prompt" aria-controls="assistant-widget-panel" rows={1} maxLength={2000} value={assistantPrompt} disabled={assistantBusy} hidden={mode === "closed"} onChange={(event) => setAssistantPrompt(event.target.value)} onKeyDown={onPromptKeyDown} placeholder="Ask Tally anything…"/>
          <button className="assistant-widget-send" hidden={mode === "closed"} disabled={assistantBusy || !assistantSubmitReady || !assistantPrompt.trim()} aria-label="Send message" title="Send"><Send size={16}/></button>
        </form> : null}
      </div>
    </div>
  </div>;
}
