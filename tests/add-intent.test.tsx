// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADD_INTENT_EVENT, useAddIntent } from "../src/lib/add-intent";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ onOpen }: { onOpen: () => void }) {
  useAddIntent("bill", onOpen);
  return null;
}

async function mount(onOpen: () => void) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(Probe, { onOpen })));
  return () => act(async () => root.unmount());
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("useAddIntent", () => {
  it("opens once from the add query parameter and clears it from the address", async () => {
    window.history.replaceState(null, "", "/bills?add=bill&month=oct");
    const onOpen = vi.fn();
    const unmount = await mount(onOpen);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?month=oct");
    await unmount();
  });

  it("ignores intents for other pages", async () => {
    window.history.replaceState(null, "", "/bills?add=debt");
    const onOpen = vi.fn();
    const unmount = await mount(onOpen);
    await act(async () => { window.dispatchEvent(new CustomEvent(ADD_INTENT_EVENT, { detail: "goal" })); });
    expect(onOpen).not.toHaveBeenCalled();
    await unmount();
  });

  it("opens when the add sheet signals the current page", async () => {
    const onOpen = vi.fn();
    const unmount = await mount(onOpen);
    await act(async () => { window.dispatchEvent(new CustomEvent(ADD_INTENT_EVENT, { detail: "bill" })); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
