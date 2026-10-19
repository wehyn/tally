import { z } from "zod";
import { isDateOnly } from "@/lib/dates";

const dateOnlySchema = z.string().refine(isDateOnly).brand<"DateOnly">();
const calendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).brand<"CalendarMonth">();
const minorUnitsSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);

const dashboardCalendarPayloadSchema = z.object({
  start: dateOnlySchema,
  end: dateOnlySchema,
  activity: z.array(z.object({
    date: dateOnlySchema,
    income_minor: minorUnitsSchema,
    spending_minor: minorUnitsSchema,
  })).transform((activity) => activity.map(({ date, income_minor, spending_minor }) => ({
    date,
    incomeMinor: income_minor,
    spendingMinor: spending_minor,
  }))),
});

export type DateOnly = z.infer<typeof dateOnlySchema>;
export type CalendarMonth = z.infer<typeof calendarMonthSchema>;
export type DailyActivity = z.infer<typeof dashboardCalendarPayloadSchema>["activity"][number];
export type CalendarCell = { readonly date: DateOnly; readonly dayNumber: number } | null;
export type CalendarWeek = readonly CalendarCell[];
export type CalendarMonthView = {
  readonly month: CalendarMonth;
  readonly start: DateOnly;
  readonly end: DateOnly;
  readonly weeks: readonly CalendarWeek[];
};
export type CalendarSeed = {
  readonly month: CalendarMonth;
  readonly activity: readonly DailyActivity[];
};

export function calendarMonthFromDate(date: string): CalendarMonth {
  if (!isDateOnly(date)) throw new Error("Choose a valid calendar date.");
  return calendarMonthSchema.parse(date.slice(0, 7));
}

export function shiftCalendarMonth(month: CalendarMonth, delta: -1 | 1): CalendarMonth {
  const [year, monthNumber] = calendarMonthSchema.parse(month).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return calendarMonthSchema.parse(`${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`);
}

function dateOnlyFor(year: number, month: number, day: number): DateOnly {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return dateOnlySchema.parse(value);
}

export function calendarMonthView(month: CalendarMonth): CalendarMonthView {
  const [year, monthNumber] = calendarMonthSchema.parse(month).split("-").map(Number);
  const start = dateOnlyFor(year, monthNumber, 1);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const end = dateOnlyFor(year, monthNumber, lastDay);
  const cells: CalendarCell[] = [];

  for (let empty = 0; empty < new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay(); empty += 1) cells.push(null);
  for (let dayNumber = 1; dayNumber <= lastDay; dayNumber += 1) {
    cells.push({ date: dateOnlyFor(year, monthNumber, dayNumber), dayNumber });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: CalendarWeek[] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return { month, start, end, weeks };
}

export function calendarActivityFromDashboard(payload: unknown, month: CalendarMonthView): readonly DailyActivity[] {
  const dashboard = dashboardCalendarPayloadSchema.parse(payload);
  if (dashboard.start !== month.start || dashboard.end !== month.end) throw new Error("Calendar activity does not match the selected month.");

  const dates = new Set<string>();
  return dashboard.activity.map((activity) => {
    if (activity.date < month.start || activity.date > month.end || dates.has(activity.date)) {
      throw new Error("Calendar activity contains an invalid date.");
    }
    dates.add(activity.date);
    return activity;
  });
}
