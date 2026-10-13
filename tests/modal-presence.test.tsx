// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ModalPresence } from "../src/components/modal-presence";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("ModalPresence", () => {
  it("keeps a closing dialog rendered but inert during its exit transition", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (open: boolean) => root.render(
      <ModalPresence open={open}>
        <section role="dialog">Dialog content</section>
      </ModalPresence>,
    );

    try {
      await act(async () => render(true));
      const backdrop = container.querySelector<HTMLDivElement>(".modal-backdrop");
      expect(backdrop).not.toBeNull();

      await act(async () => render(false));
      expect(backdrop?.hidden).toBe(false);
      expect(backdrop?.getAttribute("aria-hidden")).toBe("true");
      expect(backdrop?.hasAttribute("inert")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
