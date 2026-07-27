import type {
  Transaction,
  TransactionRow,
  MonthlyBudgetRow,
  CategoryId,
} from "@/lib/types";

/**
 * Local calendar day for a stored ISO timestamp.
 *
 * The client writes `new Date("YYYY-MM-DDT00:00:00").toISOString()` — local
 * midnight expressed in UTC. In UTC+7 that lands on the *previous* UTC day, so
 * naively slicing the ISO string (or casting it to a Postgres date) shifts the
 * expense back a day. Reading the local components is what round-trips.
 */
export const toSpentOn = (isoDate: string): string => {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Inverse of toSpentOn: "YYYY-MM-DD" → local-midnight ISO string. */
export const fromSpentOn = (spentOn: string): string =>
  new Date(`${spentOn}T00:00:00`).toISOString();

/** Month key ("YYYY-MM") for a stored ISO timestamp, using local components. */
export const monthKeyOf = (isoDate: string): string => toSpentOn(isoDate).slice(0, 7);

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
