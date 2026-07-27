import type {
  Transaction,
  TransactionRow,
  MonthlyBudgetRow,
  CategoryId,
} from "@/lib/types";
import { dayFromIso, isoFromDay, monthKeyFromIso } from "@/lib/calendar-day";

/**
 * Calendar day ⇄ stored ISO date. Both directions are timezone-independent —
 * see lib/calendar-day.ts for why they have to be. These ran server-side with
 * *local* components before, and Node on Vercel is UTC, so a day picked in
 * Cambodia was persisted one day early.
 */
export const toSpentOn   = (isoDate: string): string => dayFromIso(isoDate);
export const fromSpentOn = (spentOn: string): string => isoFromDay(spentOn);

/** Month key ("YYYY-MM") for a stored ISO date. */
export const monthKeyOf = (isoDate: string): string => monthKeyFromIso(isoDate);

export const rowToTransaction = (row: TransactionRow): Transaction => ({
  id:        row.id,
  amountUSD: Number(row.amount_usd),
  category:  row.category as CategoryId,
  note:      row.note,
  date:      fromSpentOn(row.spent_on),
});

/** Domain → DB payload. user_id is filled by the column default (auth.uid()). */
export const transactionToRow = (tx: Transaction) => ({
  id:         tx.id,
  amount_usd: tx.amountUSD,
  category:   tx.category,
  note:       tx.note,
  spent_on:   toSpentOn(tx.date),
});

export const rowsToMonthlyBalances = (
  rows: MonthlyBudgetRow[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.month] = Number(r.amount_usd);
  return out;
};
