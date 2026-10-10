import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

function parseColor(color: string) {
  const channels = color.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3) throw new Error(`Cannot parse computed color: ${color}`);
  return { red: channels[0], green: channels[1], blue: channels[2], alpha: channels[3] ?? 1 };
}

function contrastRatio(foreground: string, background: string) {
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  const luminance = ({ red, green, blue }: ReturnType<typeof parseColor>) => {
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  };
  const composite = {
    red: fg.red * fg.alpha + bg.red * (1 - fg.alpha),
    green: fg.green * fg.alpha + bg.green * (1 - fg.alpha),
    blue: fg.blue * fg.alpha + bg.blue * (1 - fg.alpha),
    alpha: 1,
  };
  const [lighter, darker] = [luminance(composite), luminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectHighContrastFocusRing(target: Locator, adjacentSurface: Locator) {
  const outline = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      color: style.outlineColor,
    };
  });
  const surface = await adjacentSurface.evaluate((element) => getComputedStyle(element).backgroundColor);
  const visible = outline.style === "solid" && outline.width >= 2 && parseColor(outline.color).alpha > 0;
  const ratio = visible ? contrastRatio(outline.color, surface) : 0;

  expect(
    visible && ratio >= 3,
    `Computed outline: ${JSON.stringify(outline)}, contrast against ${surface}: ${visible ? `${ratio.toFixed(2)}:1` : "none"}`,
  ).toBe(true);
}

/*
 * Test audit: this protects focus continuity while ArrowRight changes months and replaces the keyed week grid.
 * A regression that loses focus when the active January 31 button is removed can leave the picker closed or the
 * replacement day unfocused. JSDOM cannot verify native Chromium focus behavior on node removal; this mounts the
 * exported component through public props with no production test seam.
 */
test("keeps the calendar open and focuses February 1 when ArrowRight crosses the month boundary", async ({ page }) => {
  await page.goto("/");

  await page.locator(".chat-transaction-date-trigger").click();
  const calendar = page.locator('[role="dialog"][aria-label="Choose transaction date"]');
  await expect(calendar).toHaveAttribute("aria-hidden", "false");
  const january31 = calendar.locator(".chat-calendar-day").filter({ hasText: /^31$/ });
  await expect(january31).toBeFocused();

  await page.keyboard.press("ArrowRight");

  const february1 = calendar.locator(".chat-calendar-day").filter({ hasText: /^1$/ });
  await expect(calendar).toHaveAttribute("aria-hidden", "false");
  await expect(calendar).toHaveAttribute("data-open", "true");
  await expect(calendar.locator("h3")).toHaveText("February 2026");
  await expect(january31).toHaveCount(0);
  await expect(february1).toBeFocused();
});

/*
 * Test audit: January's five week rows become four in February, shrinking the popup by 32px in this production
 * fixture. Its top is not recalculated after month navigation, so the measured gap drifts from 4px to 36px instead
 * of staying 6px. Existing browser coverage checks month navigation and focus, while DOM tests cannot observe
 * Chromium's fixed-position geometry.
 */
test("keeps the calendar 6px above its trigger when February has one fewer week row", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  // A shorter production fixture panel positions its date trigger low enough to force above-trigger placement.
  await page.locator(".assistant-widget-panel").evaluate((element) => {
    (element as HTMLElement).style.height = "300px";
  });
  const trigger = page.locator(".chat-transaction-date-trigger");
  await trigger.click();

  const calendar = page.locator('[role="dialog"][aria-label="Choose transaction date"]');
  const weekRows = calendar.locator(".chat-calendar-weeks > .chat-calendar-row");
  await expect(calendar).toHaveAttribute("aria-hidden", "false");
  await expect(calendar).toHaveAttribute("data-open", "true");
  await expect(calendar.locator("h3")).toHaveText("January 2026");
  await expect(weekRows).toHaveCount(5);

  const measurePlacement = async () => page.evaluate(() => {
    const triggerElement = document.querySelector<HTMLElement>(".chat-transaction-date-trigger");
    const popupElement = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Choose transaction date"]');
    if (!triggerElement || !popupElement) throw new Error("Date picker trigger or calendar popup is missing.");
    const triggerRect = triggerElement.getBoundingClientRect();
    const popupRect = popupElement.getBoundingClientRect();
    return {
      gap: triggerRect.top - popupRect.bottom,
      popupHeight: popupRect.height,
      overlaps: popupRect.bottom > triggerRect.top,
    };
  });
  const january = await measurePlacement();
  expect(january.overlaps).toBe(false);
  expect(january.gap).toBeGreaterThan(0);

  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(calendar.locator("h3")).toHaveText("February 2026");
  await expect(weekRows).toHaveCount(4);

  const february = await measurePlacement();
  expect(february.popupHeight).toBeLessThan(january.popupHeight);
  expect(february.overlaps).toBe(false);
  expect(Math.abs(february.gap - 6), `February trigger-to-popup gap was ${february.gap}px`).toBeLessThanOrEqual(1);
});

/*
 * Test audit: this protects the date trigger's visible keyboard outline against a cascade regression that strips it.
 * Existing unit coverage checks focus movement, not the rendered indicator; Chromium evaluates keyboard-only
 * :focus-visible and the app CSS cascade. The fixture mounts the exported component through public props, so no seam
 * is needed.
 */
test("shows a high-contrast outline when Tab focuses the transaction date trigger", async ({ page }) => {
  await page.goto("/");
  const trigger = page.locator(".chat-transaction-date-trigger");

  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();

  await expectHighContrastFocusRing(trigger, trigger.locator("xpath=.."));
});

/*
 * Test audit: portalled calendar and listbox controls must have a visible keyboard ring with at least 3:1 contrast.
 * The current generic ring measures 2.59:1 on the calendar surface and 2.28:1 on the selected option; prior browser
 * coverage checked rollover and the date trigger only. Chromium reads computed styles, and public component props
 * keep these controls at their real owner boundary without a production seam.
 */
test("shows a 3:1 focus ring on the portalled calendar month control", async ({ page }) => {
  await page.goto("/");
  const dateTrigger = page.locator(".chat-transaction-date-trigger");

  await page.keyboard.press("Tab");
  await expect(dateTrigger).toBeFocused();
  await page.keyboard.press("ArrowDown");

  const calendar = page.locator('[role="dialog"][aria-label="Choose transaction date"]');
  await expect(calendar).toHaveAttribute("aria-hidden", "false");
  await expect(calendar.locator('.chat-calendar-day[tabindex="0"]')).toBeFocused();
  const nextMonth = calendar.getByRole("button", { name: "Next month" });

  await page.keyboard.press("Shift+Tab");
  await expect(nextMonth).toBeFocused();
  await expectHighContrastFocusRing(nextMonth, calendar);
});

test("shows a 3:1 focus ring on the portalled selected category option", async ({ page }) => {
  await page.goto("/");
  const dateTrigger = page.locator(".chat-transaction-date-trigger");
  const categoryTrigger = page.locator('button[aria-label="Category: Food"]');

  await page.keyboard.press("Tab");
  await expect(dateTrigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(categoryTrigger).toBeFocused();
  await page.keyboard.press("ArrowDown");

  const listbox = page.locator('body > [role="listbox"][aria-label="Category"]');
  await expect(listbox).toHaveAttribute("aria-hidden", "false");
  const selectedOption = listbox.getByRole("option", { name: "Food" });
  await expect(selectedOption).toBeFocused();
  await expectHighContrastFocusRing(selectedOption, selectedOption);
});

/*
 * Test audit: this protects the category trigger's keyboard and focus contract when scrolling its anchor out of
 * view closes the listbox. Chromium verifies focus returns to the trigger after the popup is removed and the
 * assistant message scroller stays at its selected position; the fixture uses the control's public props.
 */
test("returns keyboard focus to the category trigger without a scroll jump when its listbox closes offscreen", async ({ page }) => {
  await page.goto("/");
  const messages = page.getByTestId("assistant-messages");
  const trigger = page.getByRole("button", { name: "Category: Food" });

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");

  const listbox = page.getByRole("listbox", { name: "Category" });
  const listboxElement = page.locator('[role="listbox"][aria-label="Category"]');
  const activeOption = listbox.getByRole("option", { name: "Food" });
  await expect(listbox).toBeVisible();
  await expect(activeOption).toBeFocused();

  const selectedScrollTop = await messages.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });

  await expect(trigger).not.toBeInViewport();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(listbox).toBeHidden();
  await expect(listboxElement).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await messages.evaluate((element) => element.scrollTop)).toBe(selectedScrollTop);
});

/*
 * Test audit: this covers clipping by the assistant message scrollport while the anchor stays in the browser viewport.
 * Existing coverage scrolls the anchor outside the viewport, so Chromium must exercise the distinct portal/scrollport
 * boundary and verify close, focus restoration, and preservation of the user's message scroll position.
 */
test("closes the category listbox when its trigger leaves the message scrollport but stays in the viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const messages = page.getByTestId("assistant-messages");
  const trigger = page.getByRole("button", { name: "Category: Food" });

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");

  const listbox = page.getByRole("listbox", { name: "Category" });
  const listboxElement = page.locator('body > [role="listbox"][aria-label="Category"]');
  const activeOption = listbox.getByRole("option", { name: "Food" });
  await expect(listbox).toBeVisible();
  await expect(activeOption).toBeFocused();

  const clippedPosition = await messages.evaluate((element) => {
    const anchor = element.querySelector<HTMLElement>('button[aria-label="Category: Food"]');
    if (!anchor) throw new Error("Category trigger is missing from the assistant messages.");
    const scrollportTop = element.getBoundingClientRect().top;
    element.scrollTop += anchor.getBoundingClientRect().bottom - scrollportTop + 1;
    const scrollport = element.getBoundingClientRect();
    const triggerRect = anchor.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      scrollportTop: scrollport.top,
      triggerTop: triggerRect.top,
      triggerBottom: triggerRect.bottom,
      triggerLeft: triggerRect.left,
      triggerRight: triggerRect.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  expect(clippedPosition.triggerBottom).toBeLessThan(clippedPosition.scrollportTop);
  expect(clippedPosition.triggerTop).toBeGreaterThanOrEqual(0);
  expect(clippedPosition.triggerBottom).toBeLessThanOrEqual(clippedPosition.viewportHeight);
  expect(clippedPosition.triggerLeft).toBeGreaterThanOrEqual(0);
  expect(clippedPosition.triggerRight).toBeLessThanOrEqual(clippedPosition.viewportWidth);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(listbox).toBeHidden();
  await expect(listboxElement).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await messages.evaluate((element) => element.scrollTop)).toBe(clippedPosition.scrollTop);
});
