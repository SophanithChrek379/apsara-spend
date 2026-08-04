"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { monthDayBounds, todayDay } from "@/lib/calendar-day";
import type { DateFilterValue } from "@/lib/date-filter";

type Mode = DateFilterValue["mode"];

export function DateFilterSheet({
  open, monthKey, monthLabel, value, onApply, onClose,
}: {
  open: boolean;
  /** The currently selected "YYYY-MM" — Today/This week/Custom all stay
   *  inside it, so the picker's bounds and defaults are drawn from here. */
  monthKey: string;
  monthLabel: string;
  value: DateFilterValue | null;
  onApply: (value: DateFilterValue | null) => void;
  onClose: () => void;
}) {
  const { first, last } = monthDayBounds(monthKey);
  const today = todayDay();
  const defaultDay = today >= first && today <= last ? today : first;

  const [mode, setMode] = React.useState<Mode>(value?.mode ?? "today");
  const [from, setFrom] = React.useState(value?.mode === "custom" ? value.from : defaultDay);
  const [to,   setTo]   = React.useState(value?.mode === "custom" ? value.to   : defaultDay);

  // Re-seed the draft from the active filter every time the sheet opens, so
  // a cancelled edit never leaks into the next time it's opened.
  React.useEffect(() => {
    if (!open) return;
    setMode(value?.mode ?? "today");
    setFrom(value?.mode === "custom" ? value.from : defaultDay);
    setTo(value?.mode === "custom" ? value.to : defaultDay);
    // Deliberately re-seeding on `open` only — the draft is meant to hold
    // still while the sheet is open, even if `value` changes underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rangeInvalid = mode === "custom" && from > to;

  const handleApply = () => {
    if (rangeInvalid) return;
    onApply(mode === "custom" ? { mode, from, to } : { mode });
    onClose();
  };

  const handleClear = () => {
    onApply(null);
    onClose();
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl border-t bg-card">
        <SheetHeader>
          <SheetTitle className="font-display text-[17px] font-bold tracking-[-0.01em] text-foreground">
            Filter expenses
          </SheetTitle>
          <SheetDescription>Narrow {monthLabel} down to a day or range.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={mode}
            onValueChange={(next) => { if (next) setMode(next as Mode); }}
            className="w-full"
          >
            <ToggleGroupItem value="today" className="flex-1">Today</ToggleGroupItem>
            <ToggleGroupItem value="week" className="flex-1">This week</ToggleGroupItem>
            <ToggleGroupItem value="custom" className="flex-1">Custom</ToggleGroupItem>
          </ToggleGroup>

          {mode === "custom" && (
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="date-filter-from" className="text-xs text-muted-foreground">
                  From
                </Label>
                <Input
                  id="date-filter-from"
                  type="date"
                  value={from}
                  min={first}
                  max={last}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="date-filter-to" className="text-xs text-muted-foreground">
                  To
                </Label>
                <Input
                  id="date-filter-to"
                  type="date"
                  value={to}
                  min={first}
                  max={last}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
          )}
          {rangeInvalid && (
            <p className="-mt-2 text-xs text-destructive">
              Start date must be on or before the end date.
            </p>
          )}
        </div>

        <SheetFooter className="flex-row">
          {value && (
            <Button variant="ghost" onClick={handleClear} className="flex-1">
              Clear filter
            </Button>
          )}
          <SheetClose asChild>
            <Button variant="secondary" className="flex-1">Cancel</Button>
          </SheetClose>
          <Button onClick={handleApply} disabled={rangeInvalid} className="flex-1">
            Apply
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
