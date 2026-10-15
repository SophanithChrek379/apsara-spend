import { cn } from "@/lib/utils";

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** "YYYY-MM-DD" → short weekday, read as a local calendar day (no UTC shift). */
function weekdayOf(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY.format(new Date(y, m - 1, d));
}

/**
 * Header above each day's rows in the transaction list: the day on the left,
 * what was spent that day on the right. Deliberately undecorated — no band,
 * no pill. It separates from the rows by whitespace and type scale alone, and
 * the accent-coloured total is what keeps it from reading as one more expense.
 * The total arrives formatted so it follows the app's USD/KHR switch.
 */
export function DayHeader({
  day,
  label,
  total,
  count,
  first,
}: {
  /** Calendar day, "YYYY-MM-DD". */
  day: string;
  /** "Today", "Yesterday", or the display date. */
  label: string;
  total: string;
  count: number;
  first: boolean;
}) {
  const entries = `${count} ${count === 1 ? "entry" : "entries"}`;
  return (
    <div
      data-slot="day-header"
      className={cn(
        "flex items-baseline justify-between gap-3 border-b border-foreground pb-2 font-sans",
        first ? "pt-0.5" : "pt-6"
      )}
    >
      <p className="min-w-0 truncate text-xs">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="text-muted-foreground"> · {weekdayOf(day)} · {entries}</span>
      </p>
      <p
        className="flex shrink-0 items-baseline gap-1.5"
        aria-label={`Spent ${total} across ${entries}`}
      >
        <span className="text-[11px] text-muted-foreground">Total</span>
        <span className="font-numeric text-[13px] font-semibold text-primary tabular-nums">
          {total}
        </span>
      </p>
    </div>
  );
}
