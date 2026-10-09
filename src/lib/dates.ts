const MANILA = "Asia/Manila";
type DateRange = { start: string; end: string };

export function todayInManila(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function timeInManila(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MANILA,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function monthToDateRange(now: Date = new Date()): DateRange {
  const end = todayInManila(now);
  return { start: `${end.slice(0, 7)}-01`, end };
}

export function trailingDaysRange(days: number, now: Date = new Date()): DateRange {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("Days must be between 1 and 366.");
  const end = todayInManila(now);
  return { start: shiftDate(end, 1 - days), end };
}

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isUndoAvailable(undoUntil: string | null | undefined, now: number): boolean {
  if (!undoUntil || !Number.isFinite(now) || now <= 0) return false;
  const deadline = Date.parse(undoUntil);
  return Number.isFinite(deadline) && now <= deadline;
}

export function previousMonthRange(now: Date = new Date()): DateRange {
  const currentStart = monthToDateRange(now).start;
  const previousEnd = shiftDate(currentStart, -1);
  return { start: `${previousEnd.slice(0, 7)}-01`, end: previousEnd };
}
