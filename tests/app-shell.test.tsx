// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import type { PublicUser } from "../src/lib/store";

// Render the real shell markup; isolate Next's router boundary and unrelated widgets.
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/debts" }));
vi.mock("../src/components/assistant-widget", () => ({ AssistantWidget: () => null }));
vi.mock("../src/components/sign-out-button", () => ({ SignOutButton: () => null }));

describe("AppShell mobile navigation", () => {
  it("keeps accessible destinations and icons while showing no text labels", () => {
    const props = {
      user: {
        id: "user-1",
        username: "Mina",
        role: "user",
        enabled: true,
        assistantOptIn: false,
        createdAt: "2026-10-11T00:00:00.000Z",
      } satisfies PublicUser,
      assistantEnabled: false,
      assistantConfigured: false,
    } as Parameters<typeof AppShell>[0];
    const html = renderToStaticMarkup(createElement(AppShell, props, null));
    const document = new DOMParser().parseFromString(html, "text/html");
    const navigation = document.querySelector('nav[aria-label="Mobile navigation"]');
    const links = Array.from(navigation?.querySelectorAll("a") ?? []);

    expect(links.map((link) => ({
      href: link.getAttribute("href"),
      label: link.getAttribute("aria-label"),
      current: link.getAttribute("aria-current"),
      icon: Array.from(link.querySelector("svg")?.classList ?? []).find((name) => name.startsWith("lucide-")) ?? null,
      text: link.textContent?.trim() ?? "",
    }))).toEqual([
      { href: "/dashboard", label: "Overview", current: null, icon: "lucide-layout-dashboard", text: "" },
      { href: "/transactions", label: "Transactions", current: null, icon: "lucide-arrow-left-right", text: "" },
      { href: "/accounts", label: "Accounts", current: null, icon: "lucide-wallet", text: "" },
      { href: "/bills", label: "Bills", current: null, icon: "lucide-calendar-days", text: "" },
      { href: "/debts", label: "Debts", current: "page", icon: "lucide-hand-coins", text: "" },
      { href: "/goals", label: "Shared goals", current: null, icon: "lucide-target", text: "" },
      { href: "/settings", label: "Settings", current: null, icon: "lucide-settings", text: "" },
    ]);
  });
});
