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
  /** "HH:MM" (24h) the range opens at on `from`. Absent = start of day. */
  fromTime?: string;
  /** "HH:MM" (24h) the range closes at on `to`, inclusive. Absent = end of day. */
  toTime?: string;
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

/** Minutes since midnight → "HH:MM", the same shape a time input produces. */
export const timeFromMinutes = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/**
 * Whether a moment falls inside the range. The range is one continuous span —
 * from `from` at `fromTime` to `to` at `toTime` — not a daily time window, so
 * 10 Oct 8PM → 12 Oct 9AM includes all of the 11th.
 *
 * `time` is the row's "HH:MM". "YYYY-MM-DD HH:MM" keys compare correctly as
 * strings, so this stays two string comparisons.
 */
export const inRange = (day: string, r: DayRange, time = "12:00") => {
  const at = `${day} ${time}`;
  return at >= `${r.from} ${r.fromTime ?? "00:00"}` && at <= `${r.to} ${r.toTime ?? "23:59"}`;
};

/** "14:05" → "02:05PM" — the format the Add Expense sheet shows. */
function clock(time: string) {
  const [h, m] = time.split(":").map(Number);
  return `${pad(h % 12 || 12)}:${pad(m)}${h < 12 ? "AM" : "PM"}`;
}

/**
 * Days only: { "2026-10-05", "2026-10-10" } → "05–10 Oct"; one day → "05 Oct".
 * With a time on either end, both ends are spelled out so the label never
 * reads as half a range: "05 Oct 08:00AM – 10 Oct 11:59PM", or for a single
 * day "05 Oct · 08:00AM–06:00PM".
 */
export function formatRange(r: DayRange): string {
  const month = new Date(`${r.from}T12:00:00`).toLocaleDateString("en-GB", { month: "short" });
  const a = r.from.slice(8), b = r.to.slice(8);
  if (!r.fromTime && !r.toTime) return a === b ? `${a} ${month}` : `${a}–${b} ${month}`;
  const t1 = clock(r.fromTime ?? "00:00"), t2 = clock(r.toTime ?? "23:59");
  return a === b ? `${a} ${month} · ${t1}–${t2}` : `${a} ${month} ${t1} – ${b} ${month} ${t2}`;
}
