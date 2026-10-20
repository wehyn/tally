"use client";

import { useEffect, useReducer } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LEDGER_UPDATED_EVENT } from "@/lib/client-events";
import {
  calendarActivityFromDashboard,
  calendarMonthFromDate,
  calendarMonthView,
  shiftCalendarMonth,
} from "@/lib/dashboard-calendar";
import type { CalendarMonth, CalendarSeed, DailyActivity } from "@/lib/dashboard-calendar";
import { todayInManila } from "@/lib/dates";
import { formatPHP } from "@/lib/money";

type CalendarState = CalendarSeed & {
  readonly status: "ready" | "loading" | "error";
  readonly requestId: number;
};

type CalendarAction =
  | { readonly type: "show-month"; readonly month: CalendarMonth }
  | { readonly type: "refresh" }
  | { readonly type: "loaded"; readonly month: CalendarMonth; readonly requestId: number; readonly activity: readonly DailyActivity[] }
  | { readonly type: "failed"; readonly month: CalendarMonth; readonly requestId: number };

function dashboardCalendarReducer(state: CalendarState, action: CalendarAction): CalendarState {
  switch (action.type) {
    case "show-month":
      return {
        ...state,
        month: action.month,
        activity: action.month === state.month ? state.activity : [],
        status: "loading",
        requestId: state.requestId + 1,
      };
    case "refresh":
      return { ...state, status: "loading", requestId: state.requestId + 1 };
    case "loaded":
      if (action.month !== state.month || action.requestId !== state.requestId) return state;
      return { ...state, activity: action.activity, status: "ready" };
    case "failed":
      if (action.month !== state.month || action.requestId !== state.requestId) return state;
      return { ...state, status: "error" };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const weekdayLabels = [
  { short: "Sun", full: "Sunday" },
  { short: "Mon", full: "Monday" },
  { short: "Tue", full: "Tuesday" },
  { short: "Wed", full: "Wednesday" },
  { short: "Thu", full: "Thursday" },
  { short: "Fri", full: "Friday" },
  { short: "Sat", full: "Saturday" },
];

const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const compactAmountFormatter = new Intl.NumberFormat("en-PH", { notation: "compact", maximumFractionDigits: 1 });

function formatMonth(month: CalendarMonth): string {
  return monthFormatter.format(new Date(`${month}-01T00:00:00.000Z`));
}

function formatCalendarDate(date: string): string {
  return dateFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

function CalendarAmount({ kind, amountMinor }: { kind: "income" | "spending" | "debt_repayment"; amountMinor: number }) {
  const formatted = formatPHP(amountMinor);
  const exactAmount = formatted.slice(1);
  const ungroupedAmount = exactAmount.replaceAll(",", "");
  const compactAmount = compactAmountFormatter.format(amountMinor / 100);
  const compactOnMobile = ungroupedAmount.length > 7;
  const compactOnNarrowMobile = ungroupedAmount.length > 6;
  const positive = kind !== "spending";
  const label = kind === "income" ? "Income" : kind === "spending" ? "Spending" : "Debt repayment";
  return <span
    className={`month-calendar-total ${kind}${compactOnMobile ? " compact-on-mobile" : ""}${compactOnNarrowMobile ? " compact-on-narrow-mobile" : ""}`}
    aria-label={`${label}, ${positive ? "plus" : "minus"} ${formatted}`}
    title={formatted}
  >
    <span aria-hidden="true">{positive ? "+" : "−"}</span>
    <span className="month-calendar-currency" aria-hidden="true">₱</span>
    <span aria-hidden="true">
      <span className="month-calendar-total-exact">{exactAmount}</span>
      <span className="month-calendar-total-ungrouped">{ungroupedAmount}</span>
      {compactOnNarrowMobile ? <span className="month-calendar-total-compact">{compactAmount}</span> : null}
    </span>
  </span>;
}

export function DashboardCalendar({ initial }: { initial: CalendarSeed }) {
  const [calendar, dispatch] = useReducer(dashboardCalendarReducer, {
    ...initial,
    status: "ready",
    requestId: 0,
  });

  useEffect(() => {
    const refresh = () => dispatch({ type: "refresh" });
    window.addEventListener(LEDGER_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(LEDGER_UPDATED_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (calendar.status !== "loading") return;
    const controller = new AbortController();
    const requestId = calendar.requestId;
    const monthView = calendarMonthView(calendar.month);
    const query = new URLSearchParams({ start: monthView.start, end: monthView.end });

    void fetch(`/api/dashboard?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load calendar activity.");
        const payload: unknown = await response.json();
        const activity = calendarActivityFromDashboard(payload, monthView);
        dispatch({ type: "loaded", month: calendar.month, requestId, activity });
      })
      .catch(() => {
        if (!controller.signal.aborted) dispatch({ type: "failed", month: calendar.month, requestId });
      });

    return () => controller.abort();
  }, [calendar.month, calendar.requestId, calendar.status]);

  const monthView = calendarMonthView(calendar.month);
  const activityByDate = new Map(calendar.activity.map((activity) => [activity.date, activity]));
  const today = todayInManila();
  const monthLabel = formatMonth(calendar.month);

  return <article className="panel month-calendar-panel" aria-labelledby="dashboard-calendar-heading">
    <div className="month-calendar-header">
      <div className="month-calendar-title">
        <span>Activity · PHP</span>
        <h2 id="dashboard-calendar-heading">{monthLabel}</h2>
      </div>
      <div className="month-calendar-controls" aria-label="Calendar month controls">
        <button className="month-calendar-arrow" type="button" aria-label="Previous month" onClick={() => dispatch({ type: "show-month", month: shiftCalendarMonth(calendar.month, -1) })}>
          <ChevronLeft size={17} aria-hidden="true"/>
        </button>
        <button className="month-calendar-arrow" type="button" aria-label="Next month" onClick={() => dispatch({ type: "show-month", month: shiftCalendarMonth(calendar.month, 1) })}>
          <ChevronRight size={17} aria-hidden="true"/>
        </button>
        <button className="month-calendar-today" type="button" onClick={() => dispatch({ type: "show-month", month: calendarMonthFromDate(todayInManila()) })}>
          Today
        </button>
      </div>
    </div>

    {calendar.status === "loading" ? <p className="month-calendar-status" role="status">Loading activity…</p> : null}
    {calendar.status === "error" ? <div className="month-calendar-status error" role="alert">
      <span>Could not load activity for {monthLabel}.</span>
      <button className="month-calendar-retry" type="button" onClick={() => dispatch({ type: "refresh" })}>Retry</button>
    </div> : null}

    <table className="month-calendar-table">
      <caption className="sr-only">{monthLabel} income, spending, and debt repayments by day</caption>
      <thead>
        <tr>{weekdayLabels.map((weekday) => <th scope="col" key={weekday.full}><abbr title={weekday.full}>{weekday.short}</abbr></th>)}</tr>
      </thead>
      <tbody>
        {monthView.weeks.map((week, weekIndex) => <tr key={`${calendar.month}-${weekIndex}`}>
          {week.map((cell, columnIndex) => cell ? <td key={cell.date}>
            <div className="month-calendar-day">
              <time className="month-calendar-date" dateTime={cell.date} aria-label={formatCalendarDate(cell.date)} aria-current={cell.date === today ? "date" : undefined}>{cell.dayNumber}</time>
              <div className="month-calendar-totals">
                {(() => {
                  const activity = activityByDate.get(cell.date);
                  return activity ? <>
                    {activity.incomeMinor > 0 ? <CalendarAmount kind="income" amountMinor={activity.incomeMinor}/> : null}
                    {activity.spendingMinor > 0 ? <CalendarAmount kind="spending" amountMinor={activity.spendingMinor}/> : null}
                    {activity.debtRepaymentMinor > 0 ? <CalendarAmount kind="debt_repayment" amountMinor={activity.debtRepaymentMinor}/> : null}
                  </> : null;
                })()}
              </div>
            </div>
          </td> : <td className="month-calendar-empty" aria-hidden="true" key={`empty-${columnIndex}`}/>)}</tr>)}
      </tbody>
    </table>
  </article>;
}
