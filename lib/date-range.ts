/**
 * Day ranges for the transaction list's date filter. Everything here works on
 * bare "YYYY-MM-DD" calendar days (see lib/calendar-day.ts): they compare
 * correctly as strings, so a range test is two string comparisons and never
 * touches a timezone.
 */

export interface DayRange {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM" → its first and last calendar day. */
export function monthBounds(monthKey: string): DayRange {
  const [y, m] = monthKey.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  const last = new Date(y, m, 0).getDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad(last)}` };
}

/**
 * The Monday–Sunday week containing `today`, clipped to the month on screen —
 * a week that straddles a month boundary only contributes its days inside the
 * month, since the filter never reaches outside it.
 *
 * Returns null when `today` isn't in that month: "this week" has no meaning
 * while browsing another month.
 */
export function thisWeekInMonth(today: string, monthKey: string): DayRange | null {
  if (today.slice(0, 7) !== monthKey) return null;
  const [y, m, d] = today.split("-").map(Number);
  // Built and stepped at local noon, read back with local components — the
  // same day-safe pattern as formatDisplayDate.
  const t = new Date(y, m - 1, d, 12);
  const sinceMonday = (t.getDay() + 6) % 7;
  const mon = new Date(y, m - 1, d - sinceMonday, 12);
  const sun = new Date(y, m - 1, d - sinceMonday + 6, 12);
  const day = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const month = monthBounds(monthKey);
  const from = day(mon) < month.from ? month.from : day(mon);
  const to   = day(sun) > month.to   ? month.to   : day(sun);
  return { from, to };
}

/**
 * Whether a calendar day falls inside the range. Both ends are whole days, so
 * every entry on `from` and on `to` counts, whatever its time.
 */
export const inRange = (day: string, r: DayRange) => day >= r.from && day <= r.to;

/** { "2026-10-05", "2026-10-10" } → "05–10 Oct"; a single day → "05 Oct". */
export function formatRange(r: DayRange): string {
  const month = new Date(`${r.from}T12:00:00`).toLocaleDateString("en-GB", { month: "short" });
  const a = r.from.slice(8), b = r.to.slice(8);
  return a === b ? `${a} ${month}` : `${a}–${b} ${month}`;
}
