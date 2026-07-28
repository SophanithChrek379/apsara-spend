"use client";

// ─── My Report ────────────────────────────────────────────────────────────────
//
// A read-only lens over the ledger, opened from the header and closed again —
// the dashboard behind it is untouched. Every figure comes from buildReport();
// nothing here derives its own numbers, so the report and any future export of
// it can never disagree.
//
// The sheet is full-screen at every width: the report is a screen's worth of
// content, and a partial-height sheet only ever showed two cards at a time.
// Radix owns the focus trap, the Escape key and the scroll lock; the header is
// a flex sibling of the scroll container rather than `position: sticky`, so it
// cannot drift while the body scrolls under it.

import * as React from "react";
import { motion } from "framer-motion";
import { ChevronDown, Receipt, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { dayFromIso, formatDisplayDate } from "@/lib/calendar-day";
import { CATEGORIES } from "@/lib/categories";
import { PERIOD_LABELS, type ReportData, type ReportPeriod } from "@/lib/report";
import type { CategoryId, Currency } from "@/lib/types";
import { cn } from "@/lib/utils";

function StatTile({ label, value, unit, hint }: {
  label: string; value: string; unit?: string; hint: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-[14px] border border-border bg-background px-4 py-3.5">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="flex min-w-0 items-baseline gap-[3px]">
        <span className="font-display text-[26px] leading-none font-extrabold tracking-[-0.03em] text-foreground">
          {value}
        </span>
        {unit && (
          <span className="text-[13px] font-semibold text-muted-foreground">{unit}</span>
        )}
      </div>
      <div className="text-[11px] leading-[1.4] text-muted-foreground/75">{hint}</div>
    </div>
  );
}

function ReportCard({ title, caption, children }: {
  title: string; caption: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-[14px] border border-border bg-background px-4 pt-4 pb-[18px]">
      <div className="font-display text-[15px] font-bold tracking-[-0.01em] text-foreground">
        {title}
      </div>
      <div className="mt-[3px] mb-3.5 text-[11px] leading-[1.4] text-muted-foreground/80">
        {caption}
      </div>
      {children}
    </div>
  );
}

/** The Recent-entries grid. The category column is the one that can go: it is
 *  already encoded in the amount pill's colour, so dropping it on narrow
 *  screens costs nothing and keeps the note from truncating to nothing. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2.5 py-[9px] text-[13px] min-[560px]:grid-cols-[minmax(0,1fr)_80px_108px_84px]";
const CAT_CELL = "hidden min-[560px]:block";

export function ReportSheet({
  open, report, period, onPeriodChange, periodSubtitle, fmt, currency,
  onPickCategory, onClose,
}: {
  open: boolean;
  /** Null while the sheet is closed — the parent only builds a report on demand. */
  report: ReportData | null;
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  periodSubtitle: string;
  fmt: (usd: number) => string;
  currency: Currency;
  onPickCategory: (cat: CategoryId) => void;
  onClose: () => void;
}) {
  // The last report outlives `report` going null, so the closing animation has
  // something to render instead of blanking out mid-slide.
  const lastReport = React.useRef<ReportData | null>(null);
  if (report) lastReport.current = report;
  const data = report ?? lastReport.current;
  if (!data) return null;

  const {
    count, countDelta, total, avg,
    budget, budgetMonths, budgetUsedPct, remaining,
    byCategory, bySize, recent, activeDays, months,
  } = data;

  // The delta line under "Entries". Reads as prose rather than a signed number
  // because "+3" alone doesn't say more or less than *what*.
  const previousLabel = period === "month" ? "last month" : period === "year" ? "last year" : "last period";
  const deltaHint =
    countDelta === null ? `across ${activeDays} ${activeDays === 1 ? "day" : "days"}`
    : countDelta === 0  ? `same as ${previousLabel}`
    : `${Math.abs(countDelta)} ${countDelta > 0 ? "more" : "fewer"} than ${previousLabel}`;

  // Budget coverage is stated whenever the period spans more months than were
  // ever given a budget — otherwise the percentage silently measures against a
  // smaller denominator than the header implies.
  const budgetHint =
    budget === null           ? "No budget set for this period"
    : budgetMonths < months.length ? `of ${fmt(budget)} across ${budgetMonths} of ${months.length} months`
    : `of ${fmt(budget)} budget`;

  const isOver = remaining !== null && remaining < 0;
  const maxCategoryTotal = byCategory.length > 0 ? byCategory[0].total : 0;

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="inset-0 h-dvh max-h-dvh gap-0 rounded-none border-0 bg-card p-0 font-sans sm:max-w-none">

        {/* ── Title block — fixed at the top, outside the scroll container, so */}
        {/* the report always says what it is and the close button stays        */}
        {/* reachable however far down the body is scrolled.                    */}
        <div className="shrink-0 border-b border-border/70 px-5 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-3.5">
          <div className="mx-auto flex w-full max-w-[620px] items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="font-display text-[22px] leading-[1.15] font-extrabold tracking-[-0.02em] text-foreground">
                My Report
              </SheetTitle>
              <SheetDescription className="mt-1 text-xs leading-[1.4] text-muted-foreground">
                Your personal spending — {periodSubtitle}.
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button
                variant="secondary" size="icon-sm" aria-label="Close report"
                className="shrink-0 rounded-[9px] text-muted-foreground">
                <X strokeWidth={2} />
              </Button>
            </SheetClose>
          </div>
        </div>

        {/* ── Scrolling body ── */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-[calc(env(safe-area-inset-bottom)+3rem)]">
          <div className="mx-auto w-full max-w-[620px]">

            {/* Native select, restyled: the platform picker is a better control */}
            {/* on iOS than anything rebuilt in JS, and it is keyboard-accessible */}
            {/* for free. The chevron is a sibling icon, not the select's own     */}
            {/* indicator — appearance-none suppresses the platform arrow, and    */}
            {/* drawing it back with lucide keeps it the same glyph and stroke as */}
            {/* every other chevron in the app. pointer-events-none so the click  */}
            {/* still opens the native picker.                                    */}
            <div className="relative mb-4 inline-flex items-center">
              <select
                aria-label="Report period"
                value={period}
                onChange={(e) => onPeriodChange(e.target.value as ReportPeriod)}
                className="cursor-pointer appearance-none rounded-[10px] border border-input bg-background py-[9px] pr-8 pl-3 text-[13px] font-semibold text-secondary-foreground">
                {(Object.keys(PERIOD_LABELS) as ReportPeriod[]).map((p) => (
                  <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
                ))}
              </select>
              <ChevronDown
                size={14} strokeWidth={2.5} aria-hidden="true"
                className="pointer-events-none absolute right-[11px] text-muted-foreground" />
            </div>

            {count === 0 ? (
              <div className="rounded-[14px] border border-border bg-background px-5 py-10 text-center">
                <Receipt size={28} strokeWidth={1.6} className="mx-auto mb-3 text-ghost" />
                <div className="text-sm font-semibold text-muted-foreground">
                  Nothing to report yet
                </div>
                <div className="mt-1.5 text-xs leading-[1.5] text-ghost">
                  No entries in {PERIOD_LABELS[period].toLowerCase()}. Try a wider period.
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">

                {/* ── Stat tiles — 2×2 on mobile, one row of 4 once there is width ── */}
                <div className="grid grid-cols-2 gap-2.5 min-[560px]:grid-cols-4">
                  <StatTile
                    label="Entries"
                    value={String(count)}
                    hint={deltaHint}
                  />
                  <StatTile
                    label="Total spent"
                    value={fmt(total)}
                    hint={`avg ${fmt(avg)} each`}
                  />
                  <StatTile
                    label="Budget used"
                    value={budgetUsedPct === null ? "—" : String(Math.round(budgetUsedPct))}
                    unit={budgetUsedPct === null ? undefined : "%"}
                    hint={budgetHint}
                  />
                  <StatTile
                    label={isOver ? "Over budget" : "Remaining"}
                    value={remaining === null ? "—" : fmt(Math.abs(remaining))}
                    hint={
                      remaining === null ? "Set a budget to track this"
                      : isOver          ? "past your limit for this period"
                      : "left to spend this period"
                    }
                  />
                </div>

                {/* ── Spending by category ── */}
                <ReportCard
                  title="Spending by category"
                  caption="Most-spent first. Pick one to see those entries.">
                  {byCategory.map((slice, i) => {
                    const meta = CATEGORIES.find((c) => c.id === slice.id)!;
                    // Bars are scaled against the largest category, not the total,
                    // so the shape of the month stays legible when one category
                    // dominates and the rest would otherwise flatten to nothing.
                    const width = maxCategoryTotal > 0 ? (slice.total / maxCategoryTotal) * 100 : 0;
                    return (
                      <Button
                        key={slice.id}
                        variant="ghost"
                        onClick={() => onPickCategory(slice.id)}
                        aria-label={`${meta.label}, ${fmt(slice.total)} across ${slice.count} ${slice.count === 1 ? "entry" : "entries"}. Show these entries.`}
                        className={cn(
                          "h-auto w-full justify-start gap-2.5 rounded-md px-0 py-1.5",
                          i < byCategory.length - 1 && "mb-1.5",
                        )}>
                        <span
                          className="size-2.5 shrink-0 rounded-[3px]"
                          style={{ background: meta.color }} />
                        <span className="w-[68px] shrink-0 text-left text-[13px] font-semibold text-secondary-foreground">
                          {meta.label}
                        </span>
                        <span className="h-2 min-w-6 flex-1 overflow-hidden rounded-full bg-secondary">
                          <motion.span
                            initial={{ width: 0 }} animate={{ width: `${width}%` }}
                            transition={{ duration: 0.45, delay: i * 0.04, ease: [0.4, 0, 0.2, 1] }}
                            className="block h-full rounded-full"
                            style={{ background: meta.color }} />
                        </span>
                        <span
                          className="min-w-[62px] shrink-0 text-right font-numeric text-[13px] font-bold"
                          style={{ color: meta.color }}>
                          {fmt(slice.total)}
                        </span>
                      </Button>
                    );
                  })}
                  <div className="mt-2.5 text-[11px] leading-[1.45] text-muted-foreground/70">
                    {(() => {
                      const top = byCategory[0];
                      const meta = CATEGORIES.find((c) => c.id === top.id)!;
                      return `${meta.label} leads at ${Math.round(top.share)}% of spend — ${top.count} ${top.count === 1 ? "entry" : "entries"}, avg ${fmt(top.avg)}.`;
                    })()}
                  </div>
                </ReportCard>

                {/* ── By size ── */}
                <ReportCard
                  title="By size"
                  caption={`Every entry counted once — these add up to ${count}.`}>
                  {bySize.map(({ band, count: bandCount }, i) => (
                    <div
                      key={band.id}
                      className={cn(
                        "flex items-center gap-2.5 py-[5px]",
                        i < bySize.length - 1 && "mb-0.5",
                      )}>
                      <span
                        className={cn("size-[9px] shrink-0 rounded-full", bandCount === 0 && "opacity-30")}
                        style={{ background: band.color }} />
                      <span className={cn(
                        "flex-1 text-[13px] font-medium",
                        bandCount > 0 ? "text-secondary-foreground" : "text-muted-foreground",
                      )}>
                        {band.label}
                      </span>
                      <span className={cn(
                        "font-numeric text-[13px] font-bold",
                        bandCount > 0 ? "text-foreground" : "text-ghost",
                      )}>
                        {bandCount}
                      </span>
                    </div>
                  ))}
                  {currency === "KHR" && (
                    <div className="mt-2.5 text-[11px] text-muted-foreground/70">
                      Bands are USD — the ledger&apos;s base currency.
                    </div>
                  )}
                </ReportCard>

                {/* ── Recent entries ── */}
                <ReportCard
                  title="Recent entries"
                  caption={count > recent.length ? `Newest ${recent.length} of ${count}.` : "Newest first."}>
                  <div className={cn(
                    ROW,
                    "border-b border-border pt-0 pb-2 text-[10px] font-semibold tracking-[0.07em] text-muted-foreground/60 uppercase",
                  )}>
                    <span>Note</span>
                    <span className={CAT_CELL}>Category</span>
                    <span>When</span>
                    <span className="text-right">Amount</span>
                  </div>
                  {recent.map((tx, i) => {
                    const meta = CATEGORIES.find((c) => c.id === tx.category)!;
                    return (
                      <div key={tx.id} className={cn(ROW, i > 0 && "border-t border-border/60")}>
                        <span className="truncate font-semibold text-foreground">
                          {tx.note || meta.label}
                        </span>
                        <span className={cn(CAT_CELL, "text-muted-foreground")}>{meta.label}</span>
                        <span className="font-numeric text-xs text-muted-foreground">
                          {formatDisplayDate(dayFromIso(tx.date))}
                        </span>
                        <span className="text-right">
                          <span
                            className="rounded-full border px-2.5 py-[3px] font-numeric text-[11.5px] font-bold whitespace-nowrap"
                            style={{
                              background: `${meta.color}1f`,
                              borderColor: `${meta.color}40`,
                              color: meta.color,
                            }}>
                            {fmt(tx.amountUSD)}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </ReportCard>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
