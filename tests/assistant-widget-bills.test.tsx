// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import type { PublicUser } from "../src/lib/store";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("../src/components/sign-out-button", () => ({ SignOutButton: () => null }));

/* Exercise the public assistant chat flow to verify bill saves refresh Bills and the ledger without a transaction card. */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalMatchMedia = window.matchMedia;
const previewUser = {
  id: "user-1",
  username: "Mina",
  role: "user",
  enabled: true,
  assistantOptIn: true,
  createdAt: "2026-10-11T00:00:00.000Z",
} satisfies PublicUser;

function renderAssistantShell() {
  const props = { user: previewUser, assistantEnabled: true, assistantConfigured: true } as Parameters<typeof AppShell>[0];
  root.render(createElement(AppShell, props, null));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((media: string) => ({
    matches: false, media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: originalScrollTo });
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  else delete (window as Partial<Window>).matchMedia;
  vi.unstubAllGlobals();
});

describe("AssistantWidget bill saves", () => {
  it("refreshes Bills and the ledger without rendering transaction undo controls", async () => {
    const billListeners = vi.fn();
    const ledgerListeners = vi.fn();
    window.addEventListener("tally:bills-updated", billListeners);
    window.addEventListener("tally:ledger-updated", ledgerListeners);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/settings"
      ? { ok: true, json: async () => ({ assistantOptIn: true, provider: { configured: true } }) }
      : { ok: true, json: async () => ({ conversationId: "conversation-1", answer: "Saved Internet through Dec 31.", bill: { id: "bill-1" }, transaction: null, undoUntil: null }) }));
    const user = userEvent.setup();
    await act(async () => {
      renderAssistantShell();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => user.click(container.querySelector<HTMLButtonElement>('[aria-label="Open Tally assistant"]')!));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    await act(async () => {
      await user.type(container.querySelector<HTMLTextAreaElement>("#assistant-widget-prompt")!, "Add Internet bill");
      await user.keyboard("{Enter}");
    });

    expect(container.textContent).toContain("Saved Internet through Dec 31.");
    expect(container.querySelector(".chat-transaction-card")).toBeNull();
    expect(container.querySelector('[aria-label="Undo transaction"]')).toBeNull();
    expect(billListeners).toHaveBeenCalledTimes(1);
    expect(ledgerListeners).toHaveBeenCalledTimes(1);
    window.removeEventListener("tally:bills-updated", billListeners);
    window.removeEventListener("tally:ledger-updated", ledgerListeners);
  });
});
