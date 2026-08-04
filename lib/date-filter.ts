import { formatDisplayDate, todayDay, weekRangeContaining } from "./calendar-day";

export type DateFilterValue =
  | { mode: "today" }
  | { mode: "week" }
  | { mode: "custom"; from: string; to: string };

/** The inclusive "YYYY-MM-DD" range a filter value resolves to, as of now. */
export function dateFilterRange(filter: DateFilterValue): { from: string; to: string } {
  switch (filter.mode) {
    case "today": {
      const t = todayDay();
      return { from: t, to: t };
    }
    case "week": {
      const { start, end } = weekRangeContaining(todayDay());
      return { from: start, to: end };
    }
    case "custom":
      return { from: filter.from, to: filter.to };
  }
}

/** Short label for the trigger chip and the sheet's own state. */
export function dateFilterLabel(filter: DateFilterValue): string {
  switch (filter.mode) {
    case "today": return "Today";
    case "week": return "This week";
    case "custom": {
      const { from, to } = filter;
      return from === to
        ? formatDisplayDate(from)
        : `${formatDisplayDate(from)} – ${formatDisplayDate(to)}`;
    }
  }
}

/** Lowercase phrase for prose: "No entries {phrase}". */
export function dateFilterEmptyPhrase(filter: DateFilterValue): string {
  switch (filter.mode) {
    case "today": return "today";
    case "week": return "this week";
    case "custom": return "in that range";
  }
}
