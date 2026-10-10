"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { isDateOnly, todayInManila } from "@/lib/dates";

export type AssistantSelectOption = { value: string; label: string };

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type PopoverPosition = { top: number; left: number; width: number; maxHeight: number };

function usePopoverPosition(
  open: boolean,
  present: boolean,
  trigger: RefObject<HTMLButtonElement | null>,
  panel: RefObject<HTMLDivElement | null>,
  preferredWidth: number,
  maxHeight: number,
  alignEnd: boolean,
  onOpenChange: (open: boolean) => void,
) {
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  useEffect(() => {
    if (!open || !present) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popover = panel.current;
      if (!anchor || !popover) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      if (anchor.bottom < 0 || anchor.top > viewportHeight) {
        onOpenChange(false);
        return;
      }
      const margin = 12;
      const gap = 6;
      const below = Math.max(0, viewportHeight - anchor.bottom - gap - margin);
      const above = Math.max(0, anchor.top - gap - margin);
      const width = Math.min(preferredWidth, Math.max(0, viewportWidth - margin * 2));
      const desiredHeight = Math.min(popover.scrollHeight, maxHeight, viewportHeight - margin * 2);
      const openAbove = below < desiredHeight && above > below;
      const actualMaxHeight = Math.min(maxHeight, viewportHeight - margin * 2, openAbove ? above : below);
      const height = Math.min(popover.scrollHeight, actualMaxHeight);
      const preferredLeft = alignEnd ? anchor.right - width : anchor.left;
      const left = Math.max(margin, Math.min(preferredLeft, viewportWidth - width - margin));
      const top = openAbove ? anchor.top - gap - height : Math.min(viewportHeight - margin - height, anchor.bottom + gap);
      setPosition((previous) => previous?.top === top && previous.left === left && previous.width === width && previous.maxHeight === actualMaxHeight
        ? previous
        : { top, left, width, maxHeight: actualMaxHeight });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, present, trigger, panel, preferredWidth, maxHeight, alignEnd, onOpenChange]);

  return [position, setPosition] as const;
}

type AssistantSelectProps = {
  label: string;
  value: string;
  options: AssistantSelectOption[];
  disabled: boolean;
  busy: boolean;
  open: boolean;
  alignEnd?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
};

export function AssistantSelect({ label, value, options, disabled, busy, open, alignEnd = false, onOpenChange, onChange }: AssistantSelectProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [present, setPresent] = useState(false);
  const active = Math.min(activeIndex, Math.max(0, options.length - 1));
  const selected = options.find((option) => option.value === value)?.label ?? value;
  const [position, setPosition] = usePopoverPosition(open, present, trigger, popup, 218, 210, alignEnd, onOpenChange);
  const popupStyle: CSSProperties = {
    position: "fixed",
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    width: position?.width ?? 218,
    maxHeight: position?.maxHeight ?? 210,
    visibility: position ? "visible" : "hidden",
  };

  useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setPresent(false), reducedMotion() ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  useEffect(() => {
    if (!open || !position) return;
    const option = optionRefs.current[active];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [open, active, position]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node) || popup.current?.contains(event.target as Node)) return;
      onOpenChange(false);
      if (root.current?.contains(document.activeElement) || popup.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open, onOpenChange]);

  function show() {
    if (disabled || busy) return;
    setPresent(true);
    setPosition(null);
    setActiveIndex(selectedIndex);
    onOpenChange(true);
  }

  function close(restoreFocus = false) {
    onOpenChange(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function choose(option: AssistantSelectOption) {
    onChange(option.value);
    close(true);
  }

  function onOptionKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(options[index]);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && options.length) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActiveIndex(next);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && options.length) {
      const key = event.key.toLocaleLowerCase();
      const next = Array.from({ length: options.length }, (_, offset) => (index + 1 + offset) % options.length)
        .find((candidate) => options[candidate].label.toLocaleLowerCase().startsWith(key));
      if (next !== undefined) {
        event.preventDefault();
        setActiveIndex(next);
      }
    }
  }

  return <div ref={root} className="chat-transaction-control chat-transaction-select" onBlur={(event) => {
    const target = event.relatedTarget as Node | null;
    if (!target || (!event.currentTarget.contains(target) && !popup.current?.contains(target))) onOpenChange(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }}>
    <button
      ref={trigger}
      type="button"
      className="chat-transaction-trigger"
      aria-label={`${label}: ${selected}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={present ? `${id}-options` : undefined}
      aria-disabled={disabled || busy}
      onClick={() => open ? close() : show()}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          show();
        }
      }}
    >
      <span className="chat-transaction-value">{selected}</span>
      <ChevronDown className="chat-transaction-chevron" size={12} aria-hidden="true"/>
    </button>
    {present && typeof document !== "undefined" && createPortal(<div
      ref={popup}
      id={`${id}-options`}
      className="chat-transaction-menu"
      role="listbox"
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
      data-open={open && Boolean(position)}
      style={popupStyle}
    >{options.map((option, index) => <div
      key={option.value}
      ref={(element) => { optionRefs.current[index] = element; }}
      id={`${id}-option-${index}`}
      className="chat-transaction-option"
      role="option"
      aria-selected={option.value === value}
      aria-posinset={index + 1}
      aria-setsize={options.length}
      data-active={index === active}
      tabIndex={index === active ? 0 : -1}
      onFocus={() => setActiveIndex(index)}
      onClick={() => choose(option)}
      onKeyDown={(event) => onOptionKeyDown(event, index)}
    >{option.label}</div>)}</div>, document.body)}
  </div>;
}

type CalendarMonth = { year: number; month: number };
type CalendarDate = { year: number; month: number; day: number };

const WEEKDAYS = [
  ["Sun", "Sunday"], ["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"],
  ["Thu", "Thursday"], ["Fri", "Friday"], ["Sat", "Saturday"],
];

function dateParts(value: string): CalendarDate {
  const [year, month, day] = (isDateOnly(value) ? value : todayInManila()).split("-").map(Number);
  return { year, month, day };
}

function dateString({ year, month, day }: CalendarDate) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateFromParts({ year, month, day }: CalendarDate) {
  return new Date(Date.UTC(year, month - 1, day));
}

function daysInMonth({ year, month }: CalendarMonth) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthLabel(month: CalendarMonth) {
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(month.year, month.month, 1));
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "UTC" }).format(dateFromParts(dateParts(value)));
}

function accessibleDate(value: string) {
  return new Intl.DateTimeFormat("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(dateFromParts(dateParts(value)));
}

type AssistantDatePickerProps = {
  value: string;
  disabled: boolean;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
};

export function AssistantDatePicker({ value, disabled, busy, open, onOpenChange, onChange }: AssistantDatePickerProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const dayRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusActiveDate = useRef(false);
  const [present, setPresent] = useState(false);
  const selected = isDateOnly(value) ? value : todayInManila();
  const [month, setMonth] = useState<CalendarMonth>(() => {
    const { year, month } = dateParts(selected);
    return { year, month: month - 1 };
  });
  const [focusedDate, setFocusedDate] = useState(selected);
  const firstWeekday = new Date(Date.UTC(month.year, month.month, 1)).getUTCDay();
  const dayCount = daysInMonth(month);
  const weekCount = Math.ceil((firstWeekday + dayCount) / 7);
  const visibleActiveDate = (() => {
    const active = dateParts(focusedDate);
    return active.year === month.year && active.month === month.month + 1
      ? focusedDate
      : dateString({ year: month.year, month: month.month + 1, day: 1 });
  })();
  const today = todayInManila();
  const [position, setPosition] = usePopoverPosition(open, present, trigger, popup, 264, 420, true, onOpenChange);
  const popupStyle: CSSProperties = {
    position: "fixed",
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    width: position?.width ?? 264,
    maxHeight: position?.maxHeight ?? 420,
    visibility: position ? "visible" : "hidden",
  };

  useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setPresent(false), reducedMotion() ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  useEffect(() => {
    if (!open || !position || !focusActiveDate.current) return;
    focusActiveDate.current = false;
    dayRefs.current[focusedDate]?.focus({ preventScroll: true });
  }, [open, focusedDate, month, position]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node) || popup.current?.contains(event.target as Node)) return;
      onOpenChange(false);
      if (root.current?.contains(document.activeElement) || popup.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open, onOpenChange]);

  function show() {
    if (disabled || busy) return;
    setPresent(true);
    setPosition(null);
    const current = dateParts(selected);
    const nextMonth = { year: current.year, month: current.month - 1 };
    setMonth(nextMonth);
    setFocusedDate(selected);
    focusActiveDate.current = true;
    onOpenChange(true);
  }

  function close(restoreFocus = false) {
    onOpenChange(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function selectDate(date: string) {
    onChange(date);
    close(true);
  }

  function changeMonth(delta: number) {
    const next = new Date(Date.UTC(month.year, month.month + delta, 1));
    setMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
  }

  function onCalendarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const active = dateParts(focusedDate);
    const date = dateFromParts(active);
    let next: Date | null = null;
    if (event.key === "ArrowLeft") next = new Date(Date.UTC(active.year, active.month - 1, active.day - 1));
    if (event.key === "ArrowRight") next = new Date(Date.UTC(active.year, active.month - 1, active.day + 1));
    if (event.key === "ArrowUp") next = new Date(Date.UTC(active.year, active.month - 1, active.day - 7));
    if (event.key === "ArrowDown") next = new Date(Date.UTC(active.year, active.month - 1, active.day + 7));
    if (event.key === "Home") next = new Date(Date.UTC(active.year, active.month - 1, active.day - date.getUTCDay()));
    if (event.key === "End") next = new Date(Date.UTC(active.year, active.month - 1, active.day + 6 - date.getUTCDay()));
    if (event.key === "PageUp" || event.key === "PageDown") {
      const delta = (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1);
      const targetMonth = new Date(Date.UTC(active.year, active.month - 1 + delta, 1));
      const target = { year: targetMonth.getUTCFullYear(), month: targetMonth.getUTCMonth() + 1 };
      next = new Date(Date.UTC(target.year, target.month - 1, Math.min(active.day, daysInMonth({ year: target.year, month: target.month - 1 }))));
    }
    if (!next) return;
    event.preventDefault();
    const nextDate = dateString({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() });
    setFocusedDate(nextDate);
    setMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
    focusActiveDate.current = true;
  }

  const days = Array.from({ length: weekCount * 7 }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > dayCount) return null;
    return dateString({ year: month.year, month: month.month + 1, day });
  });

  return <div ref={root} className="chat-transaction-control chat-transaction-date" onBlur={(event) => {
    const target = event.relatedTarget as Node | null;
    if (!target || (!event.currentTarget.contains(target) && !popup.current?.contains(target))) onOpenChange(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }}>
    <button
      ref={trigger}
      type="button"
      className="chat-transaction-trigger chat-transaction-date-trigger"
      aria-label={`Transaction date: ${accessibleDate(selected)}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={present ? `${id}-calendar` : undefined}
      aria-disabled={disabled || busy}
      onClick={() => open ? close() : show()}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          show();
        }
      }}
    >
      <span className="chat-transaction-value">{selected === today ? "Today" : shortDate(selected)}</span>
      <CalendarDays className="chat-transaction-calendar-icon" size={12} aria-hidden="true"/>
    </button>
    {present && typeof document !== "undefined" && createPortal(<div
      ref={popup}
      id={`${id}-calendar`}
      className="chat-calendar-popover"
      role="dialog"
      aria-label="Choose transaction date"
      aria-hidden={!open}
      inert={!open}
      data-open={open && Boolean(position)}
      style={popupStyle}
    >
      <div className="chat-calendar-heading">
        <h3 id={`${id}-month`} aria-live="polite" aria-atomic="true">{monthLabel(month)}</h3>
        <div className="chat-calendar-navigation">
          <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}><ChevronLeft size={16}/></button>
          <button type="button" aria-label="Next month" onClick={() => changeMonth(1)}><ChevronRight size={16}/></button>
        </div>
      </div>
      <div className="chat-calendar-grid" role="grid" aria-labelledby={`${id}-month`} onKeyDown={onCalendarKeyDown}>
        <div className="chat-calendar-row chat-calendar-weekdays" role="row">
          {WEEKDAYS.map(([short, full]) => <span key={short} role="columnheader" aria-label={full}>{short}</span>)}
        </div>
        <div className="chat-calendar-weeks" key={`${month.year}-${month.month}`} role="rowgroup">
          {Array.from({ length: weekCount }, (_, week) => <div key={week} className="chat-calendar-row" role="row">
            {days.slice(week * 7, week * 7 + 7).map((date, column) => date ? <div key={date} className="chat-calendar-cell" role="gridcell" aria-selected={date === selected}>
              <button
                ref={(element) => { dayRefs.current[date] = element; }}
                type="button"
                className="chat-calendar-day"
                aria-label={accessibleDate(date)}
                aria-current={date === today ? "date" : undefined}
                tabIndex={date === visibleActiveDate ? 0 : -1}
                onFocus={() => setFocusedDate(date)}
                onClick={() => selectDate(date)}
              >{Number(date.slice(-2))}</button>
            </div> : <div key={`${week}-${column}`} className="chat-calendar-cell empty" role="gridcell" aria-disabled="true"/>)}
          </div>)}
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
