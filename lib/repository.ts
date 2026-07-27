import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Transaction,
  TransactionRow,
  MonthlyBudgetRow,
  SyncOp,
} from "@/lib/types";
import { rowToTransaction, transactionToRow, rowsToMonthlyBalances } from "@/lib/mappers";
import { assertMonthKey, assertUuid, assertBudgetUSD, ValidationError } from "@/lib/validation";

/**
 * All database access lives here so the REST routes and the batch/sync endpoint
 * share one implementation. Every query is implicitly scoped to the caller by
 * RLS — there is deliberately no user_id filter in the read paths, because
 * relying on the policy means a forgotten .eq() can't leak another user's rows.
 *
 * The one exception is monthly_budgets upsert, which needs user_id explicitly
 * because it is half of the composite primary key.
 */

const TX_COLUMNS = "id, amount_usd, category, note, spent_on, updated_at";

/** Inclusive start / exclusive end bounds for a "YYYY-MM" key. */
const monthBounds = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: `${month}-01`, to: next };
};

const unwrap = <T>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
};

// ── transactions ───────────────────────────────────────────────────────────

export const listTransactions = async (
  supabase: SupabaseClient,
  opts: { month?: string } = {},
): Promise<Transaction[]> => {
  let q = supabase.from("transactions").select(TX_COLUMNS).order("spent_on", { ascending: false });

  if (opts.month) {
    const { from, to } = monthBounds(assertMonthKey(opts.month));
    q = q.gte("spent_on", from).lt("spent_on", to);
  }

  const rows = unwrap(await q) as unknown as TransactionRow[];
  return rows.map(rowToTransaction);
};

export const getTransaction = async (
  supabase: SupabaseClient,
  id: string,
): Promise<Transaction | null> => {
  const res = await supabase
    .from("transactions")
    .select(TX_COLUMNS)
    .eq("id", assertUuid(id))
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data ? rowToTransaction(res.data as unknown as TransactionRow) : null;
};

/**
 * Insert-or-replace by id. Used by POST (create) and by the outbox flush, which
 * may replay a write the server already applied — upsert makes that idempotent.
 */
export const upsertTransaction = async (
  supabase: SupabaseClient,
  tx: Transaction,
): Promise<Transaction> => {
  const row = unwrap(
    await supabase
      .from("transactions")
      .upsert(transactionToRow(tx), { onConflict: "id" })
      .select(TX_COLUMNS)
      .single(),
  ) as unknown as TransactionRow;
  return rowToTransaction(row);
};

export const updateTransaction = async (
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Omit<TransactionRow, "id">>,
): Promise<Transaction | null> => {
  const res = await supabase
    .from("transactions")
    .update(patch)
    .eq("id", assertUuid(id))
    .select(TX_COLUMNS)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data ? rowToTransaction(res.data as unknown as TransactionRow) : null;
};

/** Returns false when the row did not exist (or wasn't the caller's). */
export const deleteTransaction = async (
  supabase: SupabaseClient,
  id: string,
): Promise<boolean> => {
  const rows = unwrap(
    await supabase.from("transactions").delete().eq("id", assertUuid(id)).select("id"),
  ) as unknown as { id: string }[];
  return rows.length > 0;
};

export const deleteMonthTransactions = async (
  supabase: SupabaseClient,
  month: string,
): Promise<number> => {
  const { from, to } = monthBounds(assertMonthKey(month));
  const rows = unwrap(
    await supabase
      .from("transactions")
      .delete()
      .gte("spent_on", from)
      .lt("spent_on", to)
      .select("id"),
  ) as unknown as { id: string }[];
  return rows.length;
};

// ── monthly budgets ────────────────────────────────────────────────────────

export const listBudgets = async (
  supabase: SupabaseClient,
): Promise<Record<string, number>> => {
  const rows = unwrap(
    await supabase.from("monthly_budgets").select("month, amount_usd, updated_at"),
  ) as unknown as MonthlyBudgetRow[];
  return rowsToMonthlyBalances(rows);
};

export const setBudget = async (
  supabase: SupabaseClient,
  userId: string,
  month: string,
  amount: number,
): Promise<{ month: string; amount: number }> => {
  const row = unwrap(
    await supabase
      .from("monthly_budgets")
      .upsert(
        {
          user_id:    userId, // half of the composite PK, so it must be explicit
          month:      assertMonthKey(month),
          amount_usd: assertBudgetUSD(amount),
        },
        { onConflict: "user_id,month" },
      )
      .select("month, amount_usd")
      .single(),
  ) as unknown as MonthlyBudgetRow;
  return { month: row.month, amount: Number(row.amount_usd) };
};

export const deleteBudget = async (
  supabase: SupabaseClient,
  month: string,
): Promise<boolean> => {
  const rows = unwrap(
    await supabase
      .from("monthly_budgets")
      .delete()
      .eq("month", assertMonthKey(month))
      .select("month"),
  ) as unknown as { month: string }[];
  return rows.length > 0;
};

// ── full state + batch apply ───────────────────────────────────────────────

export const fetchLedger = async (supabase: SupabaseClient) => {
  const [transactions, monthlyBalances] = await Promise.all([
    listTransactions(supabase),
    listBudgets(supabase),
  ]);
  return { transactions, monthlyBalances };
};

/**
 * Applies a list of operations in order. Used by the offline outbox flush and
 * by the one-time localStorage import.
 *
 * Not a transaction: PostgREST has no multi-statement transaction over HTTP, so
 * a mid-list failure leaves earlier ops applied. Every op is idempotent (upsert
 * by id, delete by id, upsert by month), so the client simply retries the whole
 * queue — replaying an applied op is a no-op rather than a duplicate.
 */
export const applyOps = async (
  supabase: SupabaseClient,
  userId: string,
  ops: SyncOp[],
): Promise<{ applied: number }> => {
  let applied = 0;

  for (const op of ops) {
    switch (op.type) {
      case "upsertTx":
        await upsertTransaction(supabase, op.tx);
        break;
      case "deleteTx":
        await deleteTransaction(supabase, op.id);
        break;
      case "setBudget":
        await setBudget(supabase, userId, op.month, op.amount);
        break;
      case "deleteBudget":
        await deleteBudget(supabase, op.month);
        break;
      case "resetMonth":
        await deleteMonthTransactions(supabase, op.month);
        await deleteBudget(supabase, op.month);
        break;
      default: {
        const bad = op as { type?: unknown };
        throw new ValidationError(`Unknown op type: ${String(bad.type)}`);
      }
    }
    applied++;
  }

  return { applied };
};
