// @vitest-environment jsdom

import { act, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantDatePicker, AssistantSelect } from "../src/components/assistant-transaction-controls";

/*
 * Test audit: these tests protect keyboard navigation between transaction controls and portalled calendar/listbox
 * focus stops, including forward and reverse Tab across portal boundaries. They mount exported controls with real
 * DOM portals and public props, so focus regressions are observable without a production-only test seam.
 */

const originalMatchMedia = window.matchMedia;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
let root: Root | null = null;

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

function TransactionCards() {
  const [openControl, setOpenControl] = useState<string | null>(null);
  const categoryOptions = [
    { value: "food", label: "Food" },
    { value: "other", label: "Other" },
  ];
  const accountOptions = [
    { value: "wallet", label: "Wallet" },
    { value: "bank", label: "Bank" },
  ];

  function transactionCard(id: string, label: string, date: string) {
    return <article key={id} aria-label={label}>
      <AssistantSelect
        label="Category"
        value="food"
        options={categoryOptions}
        disabled={false}
        busy={false}
        open={openControl === `${id}:category`}
        onOpenChange={(open) => setOpenControl(open ? `${id}:category` : null)}
        onChange={() => {}}
      />
      <AssistantSelect
        label="Account"
        value="wallet"
        options={accountOptions}
        disabled={false}
        busy={false}
        open={openControl === `${id}:account`}
        onOpenChange={(open) => setOpenControl(open ? `${id}:account` : null)}
        onChange={() => {}}
      />
      <AssistantDatePicker
        value={date}
        disabled={false}
        busy={false}
        open={openControl === `${id}:date`}
        onOpenChange={(open) => setOpenControl(open ? `${id}:date` : null)}
        onChange={() => {}}
      />
    </article>;
  }

  return <>
    {transactionCard("first", "First transaction", "2026-01-30")}
    {transactionCard("second", "Second transaction", "2026-01-31")}
  </>;
}

function DatePickerHarness({ onChange = () => {} }: { onChange?: (value: string) => void } = {}) {
  const [open, setOpen] = useState(false);
  return <article aria-label="Recorded transaction">
    <button type="button" aria-label="Account: Wallet">Wallet</button>
    <AssistantDatePicker
      value="2026-01-31"
      disabled={false}
      busy={false}
      open={open}
      onOpenChange={setOpen}
      onChange={onChange}
    />
    <button type="button" aria-label="Undo transaction">Undo</button>
  </article>;
}

function SelectedCategoryHarness({ onChange }: { onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return <AssistantSelect
    label="Category"
    value="food"
    options={[{ value: "food", label: "Food" }, { value: "other", label: "Other" }]}
    disabled={false}
    busy={false}
    open={open}
    onOpenChange={setOpen}
    onChange={onChange}
  />;
}

function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

async function openSecondCardCategory() {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Second transaction"] button[aria-label="Category: Food"]',
  );
  expect(trigger).not.toBeNull();

  await act(async () => trigger!.click());

  const option = document.querySelector<HTMLElement>(
    'body > [role="listbox"][aria-label="Category"] [role="option"][aria-selected="true"]',
  );
  expect(option).not.toBeNull();
  expect(document.activeElement).toBe(option);
}

async function openCalendar() {
  const trigger = document.querySelector<HTMLButtonElement>(".chat-transaction-date-trigger");
  expect(trigger).not.toBeNull();

  await act(async () => trigger!.click());

  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Choose transaction date"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}

async function openSelectedCategory() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Category: Food"]');
  expect(trigger).not.toBeNull();

  await act(async () => trigger!.click());

  const listbox = document.querySelector<HTMLElement>('body > [role="listbox"][aria-label="Category"]');
  const option = listbox?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
  expect(listbox).not.toBeNull();
  expect(option).not.toBeNull();
  expect(document.activeElement).toBe(option);
  return { trigger: trigger!, listbox: listbox!, option: option! };
}

function calendarDay(dialog: HTMLElement, day: string) {
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".chat-calendar-day"))
    .find((candidate) => candidate.textContent === day);
  expect(button).not.toBeNull();
  return button!;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }) as MediaQueryList,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();

  if (originalMatchMedia) {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

describe("assistant transaction controls", () => {
  it("moves Tab from the portalled category listbox to the next control in its transaction card", async () => {
    mount(<TransactionCards />);
    await openSecondCardCategory();
    const user = userEvent.setup();
    const accountControl = document.querySelector<HTMLButtonElement>(
      '[aria-label="Second transaction"] button[aria-label="Account: Wallet"]',
    );
    expect(accountControl).not.toBeNull();

    await act(async () => user.tab());

    expect(document.activeElement).toBe(accountControl);
  });

  it("moves Shift+Tab from the portalled category listbox to the previous transaction card control", async () => {
    mount(<TransactionCards />);
    await openSecondCardCategory();
    const user = userEvent.setup();
    const previousControl = document.querySelector<HTMLButtonElement>(
      '[aria-label="First transaction"] .chat-transaction-date-trigger',
    );
    expect(previousControl).not.toBeNull();

    await act(async () => user.tab({ shift: true }));

    expect(document.activeElement).toBe(previousControl);
  });

  it("tabs through the calendar buttons and active day before reaching the next transaction control", async () => {
    mount(<DatePickerHarness />);
    const dialog = await openCalendar();
    const previousMonth = dialog.querySelector<HTMLButtonElement>('[aria-label="Previous month"]');
    const nextMonth = dialog.querySelector<HTMLButtonElement>('[aria-label="Next month"]');
    const activeDay = calendarDay(dialog, "31");
    const nextControl = document.querySelector<HTMLButtonElement>('[aria-label="Undo transaction"]');
    expect(previousMonth).not.toBeNull();
    expect(nextMonth).not.toBeNull();
    expect(nextControl).not.toBeNull();
    expect(document.activeElement).toBe(activeDay);
    const user = userEvent.setup();

    await act(async () => {
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(nextMonth);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(previousMonth);
      await user.tab();
      expect(document.activeElement).toBe(nextMonth);
      await user.tab();
      expect(document.activeElement).toBe(activeDay);
      await user.tab();
    });

    expect(document.activeElement).toBe(nextControl);
  });

  it("moves Shift+Tab from the calendar popup boundary to the previous transaction control", async () => {
    mount(<DatePickerHarness />);
    const dialog = await openCalendar();
    const previousMonth = dialog.querySelector<HTMLButtonElement>('[aria-label="Previous month"]');
    const nextMonth = dialog.querySelector<HTMLButtonElement>('[aria-label="Next month"]');
    const activeDay = calendarDay(dialog, "31");
    const previousControl = document.querySelector<HTMLButtonElement>('[aria-label="Account: Wallet"]');
    expect(previousMonth).not.toBeNull();
    expect(nextMonth).not.toBeNull();
    expect(previousControl).not.toBeNull();
    expect(document.activeElement).toBe(activeDay);
    const user = userEvent.setup();

    await act(async () => {
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(nextMonth);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(previousMonth);
      await user.tab({ shift: true });
    });

    expect(document.activeElement).toBe(previousControl);
  });

  it("moves the focused date from January 31 to February 1 and updates the month heading", async () => {
    mount(<DatePickerHarness />);
    const dialog = await openCalendar();
    const january31 = calendarDay(dialog, "31");
    expect(document.activeElement).toBe(january31);

    await act(async () => {
      january31!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });

    const february1 = calendarDay(dialog, "1");
    expect(document.activeElement).toBe(february1);
    expect(dialog.querySelector("h3")?.textContent).toBe("February 2026");
  });

  /*
   * Test audit: activating the already-selected category with Enter or a click should dismiss the listbox without
   * reporting a value change. This protects no-op selections at the public value/onChange boundary without a seam.
   */
  it("closes the category listbox on Enter without changing the selected category", async () => {
    const onChange = vi.fn();
    mount(<SelectedCategoryHarness onChange={onChange} />);
    const { trigger, listbox } = await openSelectedCategory();
    const user = userEvent.setup();

    await act(async () => user.keyboard("{Enter}"));

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox.getAttribute("aria-hidden")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes the category listbox on clicking the selected category without changing it", async () => {
    const onChange = vi.fn();
    mount(<SelectedCategoryHarness onChange={onChange} />);
    const { trigger, listbox, option } = await openSelectedCategory();
    const user = userEvent.setup();

    await act(async () => user.click(option));

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox.getAttribute("aria-hidden")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes the date picker on Enter without changing the selected date", async () => {
    const onChange = vi.fn();
    mount(<DatePickerHarness onChange={onChange} />);
    const dialog = await openCalendar();
    const trigger = document.querySelector<HTMLButtonElement>(".chat-transaction-date-trigger")!;
    const user = userEvent.setup();

    await act(async () => user.keyboard("{Enter}"));

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog.getAttribute("aria-hidden")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes the date picker on clicking the selected date without changing it", async () => {
    const onChange = vi.fn();
    mount(<DatePickerHarness onChange={onChange} />);
    const dialog = await openCalendar();
    const selectedDay = calendarDay(dialog, "31");
    const trigger = document.querySelector<HTMLButtonElement>(".chat-transaction-date-trigger")!;
    const user = userEvent.setup();

    await act(async () => user.click(selectedDay));

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog.getAttribute("aria-hidden")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });
});
