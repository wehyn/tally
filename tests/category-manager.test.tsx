// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CategoryManager } from "../src/components/category-manager";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalUrl = window.location.href;
const originalMatchMedia = window.matchMedia;
const originalScrollTo = window.scrollTo;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: () => {} });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", originalUrl);
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  else Reflect.deleteProperty(window, "matchMedia");
  Object.defineProperty(window, "scrollTo", { configurable: true, value: originalScrollTo });
});

describe("CategoryManager", () => {
  it("opens when its section is targeted by the URL hash", async () => {
    window.history.replaceState(null, "", "#category-manager");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(createElement(CategoryManager, { categories: [], onChange: () => {}, collapsible: true })));

    const toggle = container.querySelector<HTMLButtonElement>(".category-manager-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".category-manager-disclosure")?.getAttribute("aria-hidden")).toBe("false");

    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });
});
