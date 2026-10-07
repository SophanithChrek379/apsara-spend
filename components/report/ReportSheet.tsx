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
//
// Charts are shadcn/ui's chart primitive over recharts. Series colours go in
// through ChartConfig, which scopes them as `--color-<key>` on the container —
// so marks reference `var(--color-food)` and never a hex.

import * as React from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Label, LabelList,
  Pie, PieChart, PolarAngleAxis, RadialBar, RadialBarChart, XAxis,
} from "recharts";
import { ChevronRight, Receipt, X } from "lucide-react";

import { IncomeCard } from "@/components/report/IncomeCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle,
} from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { dayFromIso, formatDisplayDate, formatDisplayTime, formatTimeOfDay } from "@/lib/calendar-day";
import { CATEGORIES } from "@/lib/categories";
import {
  PERIOD_LABELS, SIZE_BANDS, type ReportData, type ReportPeriod,
} from "@/lib/report";
import type { CategoryId, Currency } from "@/lib/types";
import { cn } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const categoryMeta = (id: CategoryId) => CATEGORIES.find((c) => c.id === id)!;

/** One config for every category chart, keyed by category id. */
const CATEGORY_CONFIG = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, { label: c.label, color: c.color }]),
) satisfies ChartConfig;

const SIZE_CONFIG = {
  count: { label: "Entries" },
  ...Object.fromEntries(SIZE_BANDS.map((b) => [b.id, { label: b.label, color: b.color }])),
} satisfies ChartConfig;

const TREND_CONFIG = {
  total: { label: "Spent", color: "var(--ui-primary)" },
} satisfies ChartConfig;

/** Category and band colours are only known at runtime. Each element that
 *  needs one gets it as a single `--swatch` custom property; every visual use
 *  of it (`bg-(--swatch)`, `text-(--swatch)/…`) stays a utility class. */
const swatch = (color: string) => ({ "--swatch": color }) as React.CSSProperties;

function SectionCard({ title, description, action, children, footer, className }: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-4 rounded-2xl border-border bg-background py-5 shadow-none", className)}>
      <CardHeader className="gap-1 px-5">
        <CardTitle className="font-display text-[15px] font-bold tracking-[-0.01em]">
          {title}
        </CardTitle>
        {description && (
          <CardDescription className="text-xs leading-[1.4]">{description}</CardDescription>
        )}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
      {footer && (
        <CardFooter className="px-5 text-[11px] leading-[1.45] text-muted-foreground">
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}

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
    byCategory, bySize, recent, activeDays, months, trend, trendUnit,
  } = data;

  // The delta line under the total. Reads as prose rather than a signed number
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
    budget === null                ? "No budget set for this period"
    : budgetMonths < months.length ? `of ${fmt(budget)} across ${budgetMonths} of ${months.length} months`
    : `of ${fmt(budget)} budget`;

  const isOver = remaining !== null && remaining < 0;
  const usedPct = budgetUsedPct === null ? 0 : Math.round(budgetUsedPct);
  const budgetColor =
    isOver        ? "var(--ui-destructive)"
    : usedPct >= 80 ? SIZE_BANDS[2].color
    : "var(--ui-primary)";

  const trendLabel = (key: string) => {
    if (trendUnit === "day") return formatDisplayDate(key);
    return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  };
  const trendTick = (key: string) =>
    trendUnit === "day" ? String(Number(key.slice(8))) : MONTHS[Number(key.slice(5, 7)) - 1];

  const trendTooltip = (
    <ChartTooltipContent
      indicator="line"
      labelFormatter={(_, payload) => trendLabel(String(payload?.[0]?.payload?.key ?? ""))}
      formatter={(value) => (
        <span className="flex w-full justify-between gap-4">
          <span className="text-muted-foreground">Spent</span>
          <span className="font-numeric font-semibold text-foreground">{fmt(Number(value))}</span>
        </span>
      )} />
  );

  const pieData = byCategory.map((s) => ({ id: s.id, total: s.total, fill: `var(--color-${s.id})` }));
  const sizeData = bySize.map(({ band, count: c }) => ({ id: band.id, label: band.label, count: c }));
  const top = byCategory[0];

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="inset-0 h-dvh max-h-dvh gap-0 rounded-none border-0 bg-card p-0 font-sans sm:max-w-none">

        {/* ── Title block — fixed at the top, outside the scroll container. ── */}
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
          <div className="mx-auto flex w-full max-w-[620px] flex-col gap-3">

            <Select value={period} onValueChange={(v) => onPeriodChange(v as ReportPeriod)}>
              <SelectTrigger
                aria-label="Report period"
                className="w-[160px] rounded-[10px] bg-background font-semibold text-secondary-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PERIOD_LABELS) as ReportPeriod[]).map((p) => (
                  <SelectItem key={p} value={p}>{PERIOD_LABELS[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {count === 0 ? (
              <>
                <Card className="items-center gap-1.5 rounded-2xl bg-background px-5 py-10 text-center shadow-none">
                  <Receipt size={28} strokeWidth={1.6} className="mb-1.5 text-ghost" />
                  <div className="text-sm font-semibold text-muted-foreground">Nothing to report yet</div>
                  <div className="text-xs leading-[1.5] text-ghost">
                    No entries in {PERIOD_LABELS[period].toLowerCase()}. Try a wider period.
                  </div>
                </Card>
                {/* Income is still worth seeing in a period with no spending. */}
                <IncomeCard report={data} fmt={fmt} />
              </>
            ) : (
              <>
                {/* ── Total spent + trend (Area chart – gradient) ── */}
                <Card className="gap-3 rounded-2xl border-border bg-background pt-5 pb-3 shadow-none">
                  <CardHeader className="gap-1 px-5">
                    <CardDescription className="text-xs">Total spent</CardDescription>
                    <CardTitle className="font-display text-[32px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">
                      {fmt(total)}
                    </CardTitle>
                    <CardAction>
                      <Badge variant="secondary" className="font-numeric">
                        {count} {count === 1 ? "entry" : "entries"}
                      </Badge>
                    </CardAction>
                    <div className="text-[11px] text-muted-foreground">
                      avg {fmt(avg)} each · {deltaHint}
                    </div>
                  </CardHeader>
                  <CardContent className="px-2">
                    <ChartContainer config={TREND_CONFIG} className="aspect-auto h-[170px] w-full">
                      {/* A day's spend is spiky — a smoothed area would dip below */}
                      {/* zero between entries, so days are bars and months a curve. */}
                      {trendUnit === "day" ? (
                        <BarChart data={trend} margin={{ left: 12, right: 12, top: 8 }}>
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="key" tickLine={false} axisLine={false} tickMargin={8}
                            minTickGap={24} tickFormatter={trendTick} />
                          <ChartTooltip cursor={false} content={trendTooltip} />
                          <Bar dataKey="total" fill="var(--color-total)" radius={3} />
                        </BarChart>
                      ) : (
                        <AreaChart data={trend} margin={{ left: 12, right: 12, top: 8 }}>
                          <defs>
                            <linearGradient id="report-trend-fill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.45} />
                              <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="key" tickLine={false} axisLine={false} tickMargin={8}
                            minTickGap={24} tickFormatter={trendTick} />
                          <ChartTooltip cursor={false} content={trendTooltip} />
                          <Area
                            dataKey="total" type="monotone" fill="url(#report-trend-fill)"
                            stroke="var(--color-total)" strokeWidth={2} />
                        </AreaChart>
                      )}
                    </ChartContainer>
                  </CardContent>
                </Card>

                {/* ── Income vs spending — salary behind Face ID ── */}
                <IncomeCard report={data} fmt={fmt} />

                {/* ── Budget (Radial chart – text) ── */}
                <SectionCard
                  title="Budget"
                  description={budgetHint}>
                  {budget === null ? (
                    <div className="text-xs text-muted-foreground">
                      Set a monthly budget on the dashboard to track it here.
                    </div>
                  ) : (
                    <div className="flex items-center gap-5">
                      <ChartContainer
                        config={{ used: { label: "Used", color: budgetColor } }}
                        className="aspect-square h-[132px] shrink-0">
                        <RadialBarChart
                          data={[{ name: "used", value: Math.min(usedPct, 100), fill: "var(--color-used)" }]}
                          startAngle={90} endAngle={-270} innerRadius={50} outerRadius={66}>
                          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
                          <RadialBar dataKey="value" background cornerRadius={10} />
                          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle">
                            <tspan x="50%" dy="-0.2em" className="fill-foreground font-display text-2xl font-extrabold">
                              {usedPct}%
                            </tspan>
                            <tspan x="50%" dy="1.6em" className="fill-muted-foreground text-[11px]">
                              used
                            </tspan>
                          </text>
                        </RadialBarChart>
                      </ChartContainer>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="text-xs text-muted-foreground">
                          {isOver ? "Over budget" : "Remaining"}
                        </div>
                        <div className={cn(
                          "font-display text-2xl leading-none font-extrabold tracking-[-0.03em] tabular-nums",
                          isOver ? "text-destructive" : "text-foreground",
                        )}>
                          {fmt(Math.abs(remaining!))}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {isOver ? "past your limit for this period" : "left to spend this period"}
                        </div>
                      </div>
                    </div>
                  )}
                </SectionCard>

                {/* ── Spending by category (Pie chart – donut with text) ── */}
                <SectionCard
                  title="Spending by category"
                  description="Most-spent first. Pick one to see those entries."
                  footer={top && `${categoryMeta(top.id).label} leads at ${Math.round(top.share)}% of spend — ${top.count} ${top.count === 1 ? "entry" : "entries"}, avg ${fmt(top.avg)}.`}>
                  <ChartContainer config={CATEGORY_CONFIG} className="mx-auto aspect-square h-[200px]">
                    <PieChart>
                      <ChartTooltip
                        cursor={false}
                        content={
                          <ChartTooltipContent
                            hideLabel nameKey="id"
                            formatter={(value, _name, item) => (
                              <span className="flex w-full justify-between gap-4">
                                <span className="text-muted-foreground">
                                  {categoryMeta(item.payload.id).label}
                                </span>
                                <span className="font-numeric font-semibold text-foreground">{fmt(Number(value))}</span>
                              </span>
                            )} />
                        } />
                      <Pie
                        data={pieData} dataKey="total" nameKey="id"
                        innerRadius={62} outerRadius={90} paddingAngle={2} strokeWidth={0}>
                        {pieData.map((d) => <Cell key={d.id} fill={d.fill} />)}
                        <Label
                          content={({ viewBox }) => {
                            if (!viewBox || !("cx" in viewBox)) return null;
                            return (
                              <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                                <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground font-display text-xl font-extrabold">
                                  {fmt(total)}
                                </tspan>
                                <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 20} className="fill-muted-foreground text-[11px]">
                                  {byCategory.length} {byCategory.length === 1 ? "category" : "categories"}
                                </tspan>
                              </text>
                            );
                          }} />
                      </Pie>
                    </PieChart>
                  </ChartContainer>

                  <div className="mt-3 flex flex-col">
                    {byCategory.map((slice) => {
                      const meta = categoryMeta(slice.id);
                      return (
                        <Button
                          key={slice.id}
                          variant="ghost"
                          onClick={() => onPickCategory(slice.id)}
                          aria-label={`${meta.label}, ${fmt(slice.total)} across ${slice.count} ${slice.count === 1 ? "entry" : "entries"}. Show these entries.`}
                          style={swatch(meta.color)}
                          className="h-auto w-full justify-start gap-2.5 rounded-lg px-2 py-2">
                          <span className="size-2.5 shrink-0 rounded-[3px] bg-(--swatch)" />
                          <span className="flex-1 text-left text-[13px] font-semibold text-secondary-foreground">
                            {meta.label}
                          </span>
                          <span className="font-numeric text-[11px] text-muted-foreground">
                            {Math.round(slice.share)}%
                          </span>
                          <span className="min-w-[64px] text-right font-numeric text-[13px] font-bold text-(--swatch)">
                            {fmt(slice.total)}
                          </span>
                          <ChevronRight className="size-3.5 text-ghost" />
                        </Button>
                      );
                    })}
                  </div>
                </SectionCard>

                {/* ── By size (Bar chart – label) ── */}
                <SectionCard
                  title="By size"
                  description={`Every entry counted once — these add up to ${count}.`}
                  footer={currency === "KHR" ? "Bands are USD — the ledger's base currency." : undefined}>
                  <ChartContainer config={SIZE_CONFIG} className="aspect-auto h-[170px] w-full">
                    <BarChart data={sizeData} margin={{ top: 22 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                      <ChartTooltip
                        cursor={false}
                        content={<ChartTooltipContent hideLabel nameKey="id" />} />
                      <Bar dataKey="count" radius={8}>
                        {sizeData.map((d) => <Cell key={d.id} fill={`var(--color-${d.id})`} />)}
                        <LabelList dataKey="count" position="top" offset={8} className="fill-foreground font-numeric text-xs font-bold" />
                      </Bar>
                    </BarChart>
                  </ChartContainer>
                </SectionCard>

                {/* ── Recent entries ── */}
                <SectionCard
                  title="Recent entries"
                  description={count > recent.length ? `Newest ${recent.length} of ${count}.` : "Newest first."}>
                  <Table className="text-[13px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-8 px-0 text-[10px] tracking-[0.07em] text-muted-foreground uppercase">Note</TableHead>
                        <TableHead className="hidden h-8 text-[10px] tracking-[0.07em] text-muted-foreground uppercase min-[560px]:table-cell">Category</TableHead>
                        <TableHead className="h-8 text-[10px] tracking-[0.07em] text-muted-foreground uppercase">When</TableHead>
                        <TableHead className="h-8 px-0 text-right text-[10px] tracking-[0.07em] text-muted-foreground uppercase">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recent.map((tx) => {
                        const meta = categoryMeta(tx.category);
                        return (
                          <TableRow key={tx.id} className="hover:bg-transparent">
                            <TableCell className="max-w-0 truncate px-0 font-semibold text-foreground">
                              {tx.note || meta.label}
                            </TableCell>
                            <TableCell className="hidden text-muted-foreground min-[560px]:table-cell">{meta.label}</TableCell>
                            <TableCell className="w-[96px] font-numeric text-xs text-muted-foreground">
                              <div>{formatDisplayDate(dayFromIso(tx.date))}</div>
                              {/* Same rule as the dashboard row: the picked time, */}
                              {/* else when the entry was created, else nothing. */}
                              {(tx.time || tx.createdAt) && (
                                <div className="mt-0.5 text-[11px] text-muted-foreground/70">
                                  {tx.time ? formatTimeOfDay(tx.time) : formatDisplayTime(tx.createdAt!)}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="w-[88px] px-0 text-right">
                              <Badge
                                variant="outline"
                                style={swatch(meta.color)}
                                className="border-(--swatch)/25 bg-(--swatch)/12 font-numeric font-bold text-(--swatch)">
                                {fmt(tx.amountUSD)}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </SectionCard>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
