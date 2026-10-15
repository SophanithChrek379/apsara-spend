"use client";

import * as React from "react";
import { CalendarDays, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle,
} from "@/components/ui/sheet";
import { OverlayPickerField } from "@/components/transactions/OverlayPickerField";
import { formatDisplayDate } from "@/lib/calendar-day";
import { formatRange, monthBounds, thisWeekInMonth, type DayRange } from "@/lib/date-range";
import { cn } from "@/lib/utils";

/**
 * A narrowing of the month on screen. `null` everywhere means "Default" — no
 * date filter, the whole month. "week" is stored as a mode rather than a range
 * so it is recomputed from today rather than frozen at the moment it was picked.
 */
export type DateFilter = { mode: "week" } | { mode: "custom"; range: DayRange };

type Mode = "default" | "week" | "custom";

/** The days a filter actually covers this month, or null for Default/unusable. */
export function resolveDateFilter(
  filter: DateFilter | null, today: string, monthKey: string,
): DayRange | null {
  if (!filter) return null;
  return filter.mode === "week" ? thisWeekInMonth(today, monthKey) : filter.range;
}

// ── Floating quick action — stacked above the Add Expense FAB ──────────────

/**
 * Two states. Idle: a 48px round secondary button, deliberately unlike the
 * amber Add Expense pill below it (shape, colour, size) so the two are hard
 * to confuse in the thumb zone. Active: grows into a pill naming the range,
 * whose label reopens the sheet and whose ✕ resets in one tap.
 */
export function DateFilterFab({
  range, onOpen, onReset,
}: {
  range: DayRange | null;
  onOpen: () => void;
  onReset: () => void;
}) {
  const shell = "rounded-full border bg-card shadow-lg shadow-black/15";

  if (!range) {
    return (
      <Button
        variant="outline"
        size="icon"
        aria-label="Filter by date"
        onClick={onOpen}
        className={cn(shell, "size-12 border-border text-foreground")}
      >
        <CalendarDays className="size-5" />
      </Button>
    );
  }

  const label = formatRange(range);
  return (
    <div className={cn(shell, "flex h-12 items-center border-primary pr-1 pl-1.5")}>
      <Button
        variant="ghost"
        onClick={onOpen}
        aria-label={`Date filter: ${label}. Change`}
        className="h-10 rounded-full px-3 font-numeric text-[13px] font-semibold text-primary tabular-nums hover:bg-primary/10 hover:text-primary"
      >
        <CalendarDays className="size-4" />
        {label}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onReset}
        aria-label="Clear date filter"
        className="size-10 rounded-full text-primary hover:bg-primary/10 hover:text-primary"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

// ── Bottom sheet ───────────────────────────────────────────────────────────

export function DateFilterSheet({
  open, onOpenChange, value, today, monthKey, monthName, onApply, onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: DateFilter | null;
  today: string;
  monthKey: string;
  /** "October" — for the description line. */
  monthName: string;
  onApply: (filter: DateFilter) => void;
  onReset: () => void;
}) {
  const bounds = monthBounds(monthKey);
  const week   = thisWeekInMonth(today, monthKey);

  // Draft choices live only while the sheet is open. Re-seeded from the
  // applied filter each time it opens (the adjust-state-during-render
  // pattern, not an effect), so closing without Apply discards the draft.
  const seed = (): { mode: Mode; from: string; to: string } =>
    !value              ? { mode: "default", from: "", to: "" }
    : value.mode === "week" ? { mode: week ? "week" : "default", from: "", to: "" }
    : { mode: "custom", from: value.range.from, to: value.range.to };

  const [draft, setDraft] = React.useState(seed);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(seed());
  }

  // iOS Safari doesn't reliably enforce min/max inside its date wheel, so a
  // pick outside the month is clamped back into it here. A start after the
  // end (or the reverse) drags the other bound along instead of raising an
  // error — the range stays valid by construction.
  const clamp = (day: string) =>
    !day ? "" : day < bounds.from ? bounds.from : day > bounds.to ? bounds.to : day;
  const setFrom = (v: string) => setDraft((d) => {
    const from = clamp(v);
    return { ...d, from, to: d.to && from > d.to ? from : d.to };
  });
  const setTo = (v: string) => setDraft((d) => {
    const to = clamp(v);
    return { ...d, to, from: d.from && to < d.from ? to : d.from };
  });

  const customValid = draft.from !== "" && draft.to !== "";
  const canApply =
    draft.mode === "week" ? week !== null
    : draft.mode === "custom" ? customValid
    : value !== null; // Default only "applies" if it changes something
  const canReset = value !== null || draft.mode !== "default";

  const apply = () => {
    if (draft.mode === "default") onReset();
    else if (draft.mode === "week") onApply({ mode: "week" });
    else onApply({ mode: "custom", range: { from: draft.from, to: draft.to } });
  };

  // Type scale and spacing copied from the Add Expense sheet so the two read
  // as one family: 24px gutters, 22px headline title with a 36px close
  // button, 48px rows and fields at 16px, a 52px primary action.
  const option = "flex min-h-12 cursor-pointer items-center gap-3 text-base font-medium text-foreground";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className={cn(
          "mx-auto w-full max-w-[480px] gap-0 rounded-t-[24px] border-border bg-card px-6 pt-7 font-sans",
          "pb-[calc(env(safe-area-inset-bottom)+2.75rem)]",
          "md:inset-y-0 md:my-auto md:h-fit md:rounded-[24px] md:border md:pb-7",
          "md:data-[state=open]:slide-in-from-bottom-4 md:data-[state=closed]:slide-out-to-bottom-4",
        )}
      >
        <div aria-hidden className="mx-auto mb-6 h-1 w-10 rounded-full bg-input md:hidden" />

        <div className="mb-4 flex items-center justify-between gap-3">
          <SheetTitle className="font-display text-[22px] leading-[1.2] font-semibold tracking-[-0.01em] text-foreground">
            Filter by date
          </SheetTitle>
          <SheetClose asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Close"
              className="size-9 shrink-0 rounded-[9px] text-muted-foreground"
            >
              <X className="size-[18px]" strokeWidth={2} />
            </Button>
          </SheetClose>
        </div>
        <SheetDescription className="sr-only">
          Narrow the {monthName} list. Your monthly total stays the same.
        </SheetDescription>

        <RadioGroup
          value={draft.mode}
          onValueChange={(m) => setDraft((d) => ({ ...d, mode: m as Mode }))}
          className="gap-0"
        >
          <Label className={option}>
            <RadioGroupItem value="default" className="size-5" />
            Default
          </Label>

          {week && (
            <Label className={option}>
              <RadioGroupItem value="week" className="size-5" />
              This week
              <span className="ml-auto font-numeric text-sm font-normal text-muted-foreground tabular-nums">
                {formatRange(week)}
              </span>
            </Label>
          )}

          <Label className={option}>
            <RadioGroupItem value="custom" className="size-5" />
            Custom range
          </Label>
        </RadioGroup>

        {/* The same picker the Add Expense sheet uses for its date, in the
            same 2-up grid — see OverlayPickerField for why it isn't a plain
            <input type="date"> (iOS renders those blank and mis-sized). */}
        {draft.mode === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-3 animate-in fade-in slide-in-from-top-1 duration-200">
            <OverlayPickerField
              type="date"
              value={draft.from}
              onChange={setFrom}
              display={formatDisplayDate(draft.from)}
              placeholder="Start date"
              icon={CalendarDays}
              min={bounds.from}
              max={bounds.to}
              aria-label="Start date"
            />
            <OverlayPickerField
              type="date"
              value={draft.to}
              onChange={setTo}
              display={formatDisplayDate(draft.to)}
              placeholder="End date"
              icon={CalendarDays}
              min={draft.from || bounds.from}
              max={bounds.to}
              aria-label="End date"
            />
          </div>
        )}

        <div className="mt-6 grid grid-cols-[auto_1fr] gap-3">
          <Button
            variant="outline"
            onClick={onReset}
            disabled={!canReset}
            className="h-[52px] rounded-[14px] px-6 text-base font-semibold"
          >
            Reset
          </Button>
          <Button
            onClick={apply}
            disabled={!canApply}
            className="h-[52px] rounded-[14px] text-base font-bold"
          >
            Apply
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Range total — heads the list while a date filter is on ──────────────────

/**
 * The answer to "how much did I spend in this range?", which the month-level
 * Total Spend card can't give. Same type scale as DayHeader, with a heavier
 * rule beneath so it reads as the parent of the day groups below it.
 */
export function RangeTotal({ range, total, count }: {
  range: DayRange; total: string; count: number;
}) {
  const entries = `${count} ${count === 1 ? "entry" : "entries"}`;
  return (
    <div
      data-slot="range-total"
      className="mb-4 flex items-baseline justify-between gap-3 border-b-2 border-foreground pb-2 font-sans"
    >
      <p className="min-w-0 truncate text-[13px]">
        <span className="font-numeric font-semibold text-foreground tabular-nums">{formatRange(range)}</span>
        <span className="text-muted-foreground"> · {entries}</span>
      </p>
      <p className="flex shrink-0 items-baseline gap-1.5" aria-label={`Spent ${total} across ${entries}`}>
        <span className="text-xs text-muted-foreground">Total</span>
        <span className="font-numeric text-[15px] font-bold text-primary tabular-nums">{total}</span>
      </p>
    </div>
  );
}
