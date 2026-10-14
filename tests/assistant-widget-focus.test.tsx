// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: "a" }));

import { AssistantWidget } from "../src/components/assistant-widget";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalMatchMedia = window.matchMedia;

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
    json: async () => ({ assistantOptIn: false, provider: { configured: false } }),
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

describe("AssistantWidget focus", () => {
  it("focuses the open chat and returns focus to its launcher when closed", async () => {
    const user = userEvent.setup();
    await act(async () => {
      root.render(createElement(AssistantWidget, { enabled: false, configured: false, initialMode: "chat" }));
      await Promise.resolve();
    });

    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close assistant"]')!;
    expect(document.activeElement).toBe(close);

    await act(async () => user.click(close));

    const launcher = container.querySelector<HTMLButtonElement>('[aria-label="Open Tally assistant"]')!;
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
      root.render(createElement(AssistantWidget, { enabled: true, configured: true, initialMode: "composing" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const prompt = container.querySelector<HTMLTextAreaElement>("#assistant-widget-prompt")!;
    await act(async () => {
      await user.type(prompt, "Lunch");
      if (submitBy === "Enter") await user.keyboard("{Enter}");
      else await user.click(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!);
    });

    expect(document.activeElement).toBe(prompt);
  });
});
