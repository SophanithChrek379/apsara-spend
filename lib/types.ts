// Shared domain types — imported by both app/page.tsx and the API layer so the
// client and the route handlers can never drift out of sync.

export type Currency   = "USD" | "KHR";
export type CategoryId = "food" | "transpo" | "bills" | "social" | "shop" | "misc";

export const CATEGORY_IDS: readonly CategoryId[] = [
  "food", "transpo", "bills", "social", "shop", "misc",
] as const;

export interface Transaction {
  id: string;
  amountUSD: number;
  category: CategoryId;
  note: string;
  date: string; // ISO local-midnight
  /**
   * When the row was created, as a real instant (unlike `date`). Server-set,
   * never sent by the client — absent on an optimistic row until the next
   * sync pulls the server's copy back down.
   */
  createdAt?: string;
}

export interface AppData {
  schema_version: number;
  transactions: Transaction[];
  /** key = "YYYY-MM", value = USD budget for that month */
  monthlyBalances: Record<string, number>;
}

export const MAX_AMOUNT_USD = 9_999.99;
export const MAX_BUDGET_USD = 9_999_999.99;

// ── Database row shapes (snake_case, as returned by PostgREST) ──────────────

export interface TransactionRow {
  id: string;
  amount_usd: number | string;
  category: string;
  note: string;
  spent_on: string;  // "YYYY-MM-DD"
  created_at: string;
  updated_at?: string;
}

export interface MonthlyBudgetRow {
  month: string;
  amount_usd: number | string;
  updated_at?: string;
}

// ── Sync operations (used by the batch endpoint + the offline outbox) ───────

export type SyncOp =
  | { type: "upsertTx";     tx: Transaction }
  | { type: "deleteTx";     id: string }
  | { type: "setBudget";    month: string; amount: number }
  | { type: "deleteBudget"; month: string }
  | { type: "resetMonth";   month: string };
