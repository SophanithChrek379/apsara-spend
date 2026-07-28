/**
 * My Report — every number on the report screen, derived in one place.
 *
 * Pure functions over the ledger the client already holds. The report needs no
 * new API and no new SQL: useSyncedLedger() hydrates every month at once (see
 * listTransactions, whose `month` option the client never passes), so period
 * comparison is a filter over state rather than a round trip.
 *
 * Nothing here imports React or touches the DOM — the UI joins these ids to
 * CATEGORIES for labels, colours and icons.
 */

import type { CategoryId, Transaction } from "@/lib/types";
import { monthKeyFromIso, dayFromIso } from "@/lib/calendar-day";

const pin2 = (v: number) => Math.round(v * 100) / 100;

// ── Month arithmetic ───────────────────────────────────────────────────────
// Done on the "YYYY-MM" key directly rather than via Date. A month key names a
// month, not an instant; constructing a Date to step it would drag the ambient
// timezone into a calculation that has no business knowing about one — the same
// class of bug lib/calendar-day.ts exists to prevent.

const pad2 = (n: number) => String(n).padStart(2, "0");

const parseMonth = (key: string): { year: number; month: number } => ({
  year:  Number(key.slice(0, 4)),
  month: Number(key.slice(5, 7)),
});

export const monthKeyOf = (year: number, month: number) => `${year}-${pad2(month)}`;

/** Step a "YYYY-MM" key by whole months, in either direction. */
export const addMonths = (key: string, delta: number): string => {
  const { year, month } = parseMonth(key);
  const ordinal = year * 12 + (month - 1) + delta;
  return monthKeyOf(Math.floor(ordinal / 12), (ordinal % 12) + 1);
};

// ── Period ─────────────────────────────────────────────────────────────────

export type ReportPeriod = "month" | "3mo" | "year" | "all";

export const PERIOD_LABELS: Record<ReportPeriod, string> = {
  month: "This month",
  "3mo": "Last 3 months",
  year:  "This year",
  all:   "All time",
};

/**
 * The months a period covers, ascending.
 *
 * `anchor` is the month the dashboard is currently showing, so opening the
 * report from June reports on June — not on whatever today happens to be.
 * "This year" is the anchor's whole calendar year, January → December: the
 * period names a year, and clipping it at the anchor made it silently hide
 * entries the user can see elsewhere in the app (opening the report from
 * January reported on January alone). Months with no entries contribute
 * nothing, and only months actually given a budget enter the budget
 * denominator, so the empty tail costs no accuracy.
 */
export const monthsInPeriod = (
  period: ReportPeriod,
  anchor: string,
  ledgerMonths: string[],
): string[] => {
  switch (period) {
    case "month":
      return [anchor];
    case "3mo":
      return [addMonths(anchor, -2), addMonths(anchor, -1), anchor];
    case "year": {
      const { year } = parseMonth(anchor);
      return Array.from({ length: 12 }, (_, i) => monthKeyOf(year, i + 1));
    }
    case "all":
      return ledgerMonths.length > 0 ? ledgerMonths : [anchor];
  }
};

/**
 * The comparable window immediately before this one, for the "n more than last
 * period" delta. "All time" has nothing before it, so it gets no delta.
 *
 * "This year" compares against the previous calendar year, matching the window
 * it now covers.
 */
const previousPeriod = (period: ReportPeriod, anchor: string): string[] | null => {
  switch (period) {
    case "month":
      return [addMonths(anchor, -1)];
    case "3mo":
      return [addMonths(anchor, -5), addMonths(anchor, -4), addMonths(anchor, -3)];
    case "year": {
      const { year } = parseMonth(anchor);
      return Array.from({ length: 12 }, (_, i) => monthKeyOf(year - 1, i + 1));
    }
    case "all":
      return null;
  }
};

// ── Size bands ─────────────────────────────────────────────────────────────
// The analogue of WeMeet's "By status": every entry falls in exactly one band,
// so the counts sum to the entry total. Answers a question no other card on the
// dashboard does — whether a month is death-by-small-cuts or a few large hits.
// Colours are the app's existing budget-tier ramp, coolest to hottest.

export interface SizeBand {
  id: string;
  label: string;
  color: string;
  /** Inclusive lower bound, exclusive upper. */
  min: number;
  max: number;
}

export const SIZE_BANDS: readonly SizeBand[] = [
  { id: "xs", label: "Under $5",  color: "#34d399", min: 0,  max: 5        },
  { id: "sm", label: "$5 – $20",  color: "#3b82f6", min: 5,  max: 20       },
  { id: "md", label: "$20 – $50", color: "#f59e0b", min: 20, max: 50       },
  { id: "lg", label: "$50+",      color: "#ef4444", min: 50, max: Infinity },
] as const;

const bandOf = (amount: number): SizeBand =>
  SIZE_BANDS.find((b) => amount >= b.min && amount < b.max) ?? SIZE_BANDS[SIZE_BANDS.length - 1];

// ── Report ─────────────────────────────────────────────────────────────────

export interface CategorySlice {
  id: CategoryId;
  total: number;
  count: number;
  /** Mean spend per entry in this category. */
  avg: number;
  /** Percent of the period's total spend, 0–100. */
  share: number;
}

export interface BandSlice {
  band: SizeBand;
  count: number;
}

export interface ReportData {
  /** Months covered, ascending. */
  months: string[];
  /** Every transaction in scope, newest first. */
  txs: Transaction[];

  count: number;
  /** Entry-count change vs the preceding window; null for "all time". */
  countDelta: number | null;

  total: number;
  /** Mean spend per entry; 0 when there are no entries. */
  avg: number;

  /**
   * Summed budget of the in-scope months that have one. null when none do.
   *
   * budgetMonths vs months.length matters for the multi-month periods: a
   * 3-month window where only two months were ever given a budget is measured
   * against those two, and the UI says so rather than implying full coverage.
   */
  budget: number | null;
  budgetMonths: number;
  /** total ÷ budget as a percent, uncapped so over-budget reads above 100. */
  budgetUsedPct: number | null;
  /** budget − total. Negative means over. null when no budget is set. */
  remaining: number | null;

  byCategory: CategorySlice[];
  bySize: BandSlice[];
  recent: Transaction[];

  /** Distinct calendar days with at least one entry. */
  activeDays: number;
}

const RECENT_LIMIT = 5;

/**
 * Descending by day, id breaking ties so the order is stable across renders.
 *
 * The tiebreak direction matches the dashboard's `sortedTxs` deliberately. Ids
 * are uuids, so neither direction means anything on its own — but the report's
 * "Recent entries" and the list behind it show the same rows, and same-day
 * entries appearing in opposite orders in the two places reads as a bug.
 */
const byNewest = (a: Transaction, b: Transaction) => {
  const d = dayFromIso(b.date).localeCompare(dayFromIso(a.date));
  return d !== 0 ? d : b.id.localeCompare(a.id);
};

export const buildReport = (
  transactions: Transaction[],
  monthlyBalances: Record<string, number>,
  period: ReportPeriod,
  anchorMonth: string,
): ReportData => {
  const ledgerMonths = Array.from(new Set(transactions.map((t) => monthKeyFromIso(t.date)))).sort();

  const months  = monthsInPeriod(period, anchorMonth, ledgerMonths);
  const inScope = new Set(months);
  const txs     = transactions.filter((t) => inScope.has(monthKeyFromIso(t.date))).sort(byNewest);

  const count = txs.length;
  const total = pin2(txs.reduce((s, t) => s + t.amountUSD, 0));
  const avg   = count > 0 ? pin2(total / count) : 0;

  const prevMonths = previousPeriod(period, anchorMonth);
  const countDelta = prevMonths === null
    ? null
    : count - transactions.filter((t) => prevMonths.includes(monthKeyFromIso(t.date))).length;

  // Only months actually given a budget contribute to the denominator — a month
  // left unset means "no budget", not "a budget of zero", and averaging a zero
  // in would understate every percentage.
  const budgeted     = months.filter((m) => (monthlyBalances[m] ?? 0) > 0);
  const budget       = budgeted.length > 0
    ? pin2(budgeted.reduce((s, m) => s + monthlyBalances[m], 0))
    : null;
  const budgetUsedPct = budget !== null && budget > 0 ? (total / budget) * 100 : null;
  const remaining     = budget !== null ? pin2(budget - total) : null;

  const byCategory = Object.entries(
    txs.reduce<Record<string, { total: number; count: number }>>((acc, t) => {
      const slot = acc[t.category] ?? (acc[t.category] = { total: 0, count: 0 });
      slot.total += t.amountUSD;
      slot.count += 1;
      return acc;
    }, {}),
  )
    .map(([id, { total: catTotal, count: catCount }]): CategorySlice => ({
      id:    id as CategoryId,
      total: pin2(catTotal),
      count: catCount,
      avg:   pin2(catTotal / catCount),
      share: total > 0 ? (catTotal / total) * 100 : 0,
    }))
    // Most-spent first, mirroring the dashboard breakdown. Ties fall back to the
    // id so two equal categories don't swap places between renders.
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));

  const bandCounts = txs.reduce<Record<string, number>>((acc, t) => {
    const id = bandOf(t.amountUSD).id;
    acc[id] = (acc[id] ?? 0) + 1;
    return acc;
  }, {});
  const bySize = SIZE_BANDS.map((band) => ({ band, count: bandCounts[band.id] ?? 0 }));

  const activeDays = new Set(txs.map((t) => dayFromIso(t.date))).size;

  return {
    months, txs,
    count, countDelta,
    total, avg,
    budget, budgetMonths: budgeted.length, budgetUsedPct, remaining,
    byCategory, bySize,
    recent: txs.slice(0, RECENT_LIMIT),
    activeDays,
  };
};
