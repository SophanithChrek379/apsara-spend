/**
 * Income vs spending — the report's salary comparison, derived in one place.
 *
 * Salary is entered per calendar year (it changes year to year) and spread
 * evenly across that year's months: a month "earns" amount ÷ 12. Comparisons
 * only ever count months that have both happened and have a salary on file, so
 * "This year" in October weighs ten months of spending against ten months of
 * pay — not against the whole year's salary, which would flatter every figure.
 *
 * Pure, like lib/report.ts: no React, no DOM, no fetching.
 */

import type { AnnualIncome } from "@/lib/types";
import type { ReportData } from "@/lib/report";
import { monthKeyFromIso, todayDay } from "@/lib/calendar-day";

const pin2 = (v: number) => Math.round(v * 100) / 100;

const yearOf = (monthKey: string) => Number(monthKey.slice(0, 4));

export interface IncomePoint {
  /** "YYYY-MM" */
  key: string;
  /** Monthly share of that year's salary; null when unknown or still ahead. */
  income: number | null;
  /** null for a month still ahead, so the chart leaves a gap. */
  spent: number | null;
}

export interface IncomeComparison {
  /** Salary for the year the report is anchored on; null when not entered. */
  salary: number | null;
  salaryYear: number;
  /** The year before's salary, for the raise line; null when not entered. */
  previousSalary: number | null;
  /** Percent change vs previousSalary; null without both years. */
  salaryChangePct: number | null;

  /** Months that are both elapsed and have a salary for their year. */
  coveredMonths: number;
  /** Elapsed months in the period, covered or not. */
  elapsedMonths: number;
  /** Elapsed years in the period that have no salary entered. */
  missingYears: number[];

  earned: number;
  /** Spending inside the covered months only — like for like with `earned`. */
  spent: number;
  /** earned − spent. Negative means spending outran income. */
  saved: number;
  /** spent ÷ earned as a percent, uncapped; null when nothing was earned. */
  spentPct: number | null;
  /** saved ÷ earned as a percent; null when nothing was earned. */
  savingsRate: number | null;

  series: IncomePoint[];
}

export const buildIncomeComparison = (
  report: Pick<ReportData, "months" | "txs">,
  income: AnnualIncome,
  today: string = todayDay(),
): IncomeComparison => {
  const nowMonth   = today.slice(0, 7);
  const salaryYear = yearOf(report.months[report.months.length - 1] ?? nowMonth);
  const salary         = income[salaryYear] ?? null;
  const previousSalary = income[salaryYear - 1] ?? null;
  const salaryChangePct =
    salary !== null && previousSalary !== null && previousSalary > 0
      ? ((salary - previousSalary) / previousSalary) * 100
      : null;

  const spentByMonth = new Map<string, number>();
  for (const t of report.txs) {
    const key = monthKeyFromIso(t.date);
    spentByMonth.set(key, (spentByMonth.get(key) ?? 0) + t.amountUSD);
  }

  const elapsed = report.months.filter((m) => m <= nowMonth);
  const covered = elapsed.filter((m) => income[yearOf(m)] !== undefined);
  const missingYears = Array.from(new Set(elapsed.map(yearOf)))
    .filter((y) => income[y] === undefined);

  const earned = pin2(covered.reduce((s, m) => s + income[yearOf(m)] / 12, 0));
  const spent  = pin2(covered.reduce((s, m) => s + (spentByMonth.get(m) ?? 0), 0));
  const saved  = pin2(earned - spent);

  return {
    salary, salaryYear, previousSalary, salaryChangePct,
    coveredMonths: covered.length,
    elapsedMonths: elapsed.length,
    missingYears,
    earned, spent, saved,
    spentPct:    earned > 0 ? (spent / earned) * 100 : null,
    savingsRate: earned > 0 ? (saved / earned) * 100 : null,
    series: report.months.map((key) => {
      const ahead  = key > nowMonth;
      const annual = income[yearOf(key)];
      return {
        key,
        income: ahead || annual === undefined ? null : pin2(annual / 12),
        spent:  ahead ? null : pin2(spentByMonth.get(key) ?? 0),
      };
    }),
  };
};
