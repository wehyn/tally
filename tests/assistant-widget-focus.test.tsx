// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: "a" }));

import { AppShell } from "../src/components/app-shell";
import type { PublicUser } from "../src/lib/store";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("../src/components/sign-out-button", () => ({ SignOutButton: () => null }));

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
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ assistantOptIn: true, provider: { configured: true } }),
  }));
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

describe("Assistant composer focus", () => {
  it("focuses the mobile prompt on first open and restores the launcher after Escape", async () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((media: string) => ({
      matches: media === "(max-width: 900px)",
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) });
    const user = userEvent.setup();
    await act(async () => {
      renderAssistantShell();
    });

    const launcher = container.querySelector<HTMLButtonElement>('[aria-label="Open Tally assistant"]')!;
    await act(async () => user.click(launcher));

    const prompt = container.querySelector<HTMLTextAreaElement>("#assistant-widget-prompt")!;
    expect(document.activeElement).toBe(prompt);

    await act(async () => user.keyboard("{Escape}"));
    expect(document.activeElement).toBe(launcher);
  });

  it.each(["Enter", "Send button"] as const)("returns focus to the composer after submitting with %s", async (submitBy) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input) === "/api/settings"
        ? { assistantOptIn: true, provider: { configured: true } }
        : { conversationId: "conversation-1", answer: "Recorded." },
    })));
    const user = userEvent.setup();
    await act(async () => {
      renderAssistantShell();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const launcher = container.querySelector<HTMLButtonElement>('[aria-label="Open Tally assistant"]')!;
    await act(async () => user.click(launcher));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    const prompt = container.querySelector<HTMLTextAreaElement>("#assistant-widget-prompt")!;
    await act(async () => {
      await user.type(prompt, "Lunch");
      if (submitBy === "Enter") await user.keyboard("{Enter}");
      else await user.click(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!);
    });

    expect(document.activeElement).toBe(prompt);
  });
});
