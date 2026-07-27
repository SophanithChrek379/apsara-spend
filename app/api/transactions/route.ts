import { NextResponse } from "next/server";
import { requireUser, route, readJson } from "@/lib/api-helpers";
import {
  listTransactions,
  upsertTransaction,
  deleteMonthTransactions,
} from "@/lib/repository";
import { parseTransactionInput, assertMonthKey, ValidationError } from "@/lib/validation";

/**
 * GET /api/transactions
 * GET /api/transactions?month=YYYY-MM
 */
export const GET = route(async (req) => {
  const { supabase } = await requireUser();
  const month = new URL(req.url).searchParams.get("month") ?? undefined;
  const transactions = await listTransactions(supabase, { month });
  return NextResponse.json({ transactions });
});

/**
 * POST /api/transactions
 * Body: { id?, amountUSD, category, note, date }
 *
 * The client supplies the uuid so optimistic UI has a stable key before the
 * response lands, and so a replayed offline write upserts instead of duplicating.
 * An absent id is generated server-side.
 */
export const POST = route(async (req) => {
  const { supabase } = await requireUser();
  const body = await readJson(req);
  const { tx } = parseTransactionInput(body);

  const saved = await upsertTransaction(supabase, {
    ...tx,
    id: tx.id || crypto.randomUUID(),
  });

  return NextResponse.json({ transaction: saved }, { status: 201 });
});

/**
 * DELETE /api/transactions?month=YYYY-MM
 * Bulk clear for the "Reset month" action. The month param is mandatory —
 * without it this would be an unguarded "delete my whole ledger" call.
 */
export const DELETE = route(async (req) => {
  const { supabase } = await requireUser();
  const month = new URL(req.url).searchParams.get("month");
  if (!month) throw new ValidationError("month query parameter is required");

  const deleted = await deleteMonthTransactions(supabase, assertMonthKey(month));
  return NextResponse.json({ deleted });
});
