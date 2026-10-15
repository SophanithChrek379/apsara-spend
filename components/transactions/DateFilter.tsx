"use client";

import * as React from "react";
import { CalendarDays, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetTitle,
} from "@/components/ui/sheet";
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

  const customValid =
    draft.from !== "" && draft.to !== "" && draft.from <= draft.to;
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

  const option = "flex min-h-11 items-center gap-3 text-sm font-medium text-foreground";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className={cn(
          "mx-auto w-full max-w-[480px] gap-0 rounded-t-[22px] border-border bg-card px-5 pt-3 font-sans",
          "pb-[calc(env(safe-area-inset-bottom)+1.25rem)]",
          "md:inset-y-0 md:my-auto md:h-fit md:rounded-[22px] md:border md:pb-5",
          "md:data-[state=open]:slide-in-from-bottom-4 md:data-[state=closed]:slide-out-to-bottom-4",
        )}
      >
        <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-border md:hidden" />

        <SheetTitle className="font-display text-lg font-bold text-foreground">
          Filter by date
        </SheetTitle>
        <SheetDescription className="mt-0.5 text-xs text-muted-foreground">
          Narrow the {monthName} list. Your monthly total stays the same.
        </SheetDescription>

        <RadioGroup
          value={draft.mode}
          onValueChange={(m) => setDraft((d) => ({ ...d, mode: m as Mode }))}
          className="mt-4 gap-1"
        >
          <Label className={option}>
            <RadioGroupItem value="default" />
            Default
          </Label>

          {week && (
            <Label className={option}>
              <RadioGroupItem value="week" />
              This week
              <span className="ml-auto font-numeric text-xs font-normal text-muted-foreground tabular-nums">
                {formatRange(week)}
              </span>
            </Label>
          )}

          <Label className={option}>
            <RadioGroupItem value="custom" />
            Custom range
          </Label>
        </RadioGroup>

        {draft.mode === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-3 pl-7 animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="grid gap-1.5">
              <Label htmlFor="date-filter-from" className="text-xs text-muted-foreground">Start</Label>
              <Input
                id="date-filter-from"
                type="date"
                min={bounds.from}
                max={draft.to || bounds.to}
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                className="h-11 font-numeric tabular-nums"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="date-filter-to" className="text-xs text-muted-foreground">End</Label>
              <Input
                id="date-filter-to"
                type="date"
                min={draft.from || bounds.from}
                max={bounds.to}
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                className="h-11 font-numeric tabular-nums"
              />
            </div>
            {draft.from && draft.to && draft.from > draft.to && (
              <p role="alert" className="col-span-2 text-xs text-destructive">
                End date must be on or after the start date.
              </p>
            )}
          </div>
        )}

        <SheetFooter className="mt-6 grid grid-cols-[auto_1fr] gap-3 p-0">
          <Button
            variant="outline"
            onClick={onReset}
            disabled={!canReset}
            className="h-11 rounded-[12px] px-5"
          >
            Reset
          </Button>
          <Button
            onClick={apply}
            disabled={!canApply}
            className="h-11 rounded-[12px] font-semibold"
          >
            Apply
          </Button>
        </SheetFooter>
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
