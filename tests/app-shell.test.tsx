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
  it("keeps primary destinations in mobile navigation and puts Settings in the account menu", () => {
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
      { href: "/dashboard", label: "Home", current: null, icon: "lucide-layout-dashboard", text: "Home" },
      { href: "/money", label: "Money", current: null, icon: "lucide-wallet", text: "Money" },
      { href: "/plan", label: "Plan", current: "location", icon: "lucide-calendar-days", text: "Plan" },
    ]);

    const primaryLinks = Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] a'));
    expect(primaryLinks.map((link) => link.getAttribute("href"))).toEqual(["/dashboard", "/money", "/plan"]);
    expect(primaryLinks[2].getAttribute("aria-current")).toBe("location");
    expect(primaryLinks.map((link) => link.getAttribute("href"))).not.toContain("/settings");
    expect(primaryLinks.map((link) => link.getAttribute("href"))).not.toContain("/admin");
    expect(Array.from(document.querySelectorAll('nav[aria-label="Account navigation"] a')).map((link) => link.getAttribute("href"))).toEqual(["/settings"]);
  });

  it("keeps Administration out of mobile navigation and in the admin account menu", () => {
    const props = {
      user: {
        id: "admin-1",
        username: "Admin",
        role: "admin",
        enabled: true,
        assistantOptIn: false,
        createdAt: "2026-10-11T00:00:00.000Z",
      } satisfies PublicUser,
      assistantEnabled: false,
      assistantConfigured: false,
    } as Parameters<typeof AppShell>[0];
    const html = renderToStaticMarkup(createElement(AppShell, props, null));
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll('nav[aria-label="Mobile navigation"] a'));
    const primaryLinks = Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] a'));

    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute("href"))).not.toContain("/settings");
    expect(links.map((link) => link.getAttribute("href"))).not.toContain("/admin");
    expect(primaryLinks.map((link) => link.getAttribute("href"))).not.toContain("/settings");
    expect(primaryLinks.map((link) => link.getAttribute("href"))).not.toContain("/admin");
    expect(Array.from(document.querySelectorAll('nav[aria-label="Account navigation"] a')).map((link) => link.getAttribute("href"))).toEqual(["/settings", "/admin"]);
  });
});
