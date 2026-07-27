import { NextResponse } from "next/server";
import { requireUser, route, readJson } from "@/lib/api-helpers";
import { listBudgets, setBudget, deleteBudget } from "@/lib/repository";
import { assertMonthKey, assertBudgetUSD, ValidationError } from "@/lib/validation";

/**
 * GET /api/budgets
 * → { monthlyBalances: { "2026-07": 300, ... } }
 *
 * Returned as a map rather than an array so it drops straight into the shape
 * the client already uses for AppData.monthlyBalances.
 */
export const GET = route(async () => {
  const { supabase } = await requireUser();
  const monthlyBalances = await listBudgets(supabase);
  return NextResponse.json({ monthlyBalances });
});

/**
 * PUT /api/budgets
 * Body: { month: "YYYY-MM", amount: number }
 *
 * PUT rather than POST because it's an idempotent upsert on (user, month) —
 * the app lets a budget be revised mid-month, so set and update are one path.
 */
export const PUT = route(async (req) => {
  const { supabase, user } = await requireUser();
  const body = await readJson(req);

  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be an object");
  }
  const b = body as Record<string, unknown>;

  const saved = await setBudget(
    supabase,
    user.id,
    assertMonthKey(b.month),
    assertBudgetUSD(b.amount),
  );

  return NextResponse.json({ budget: saved });
});

/** DELETE /api/budgets?month=YYYY-MM */
export const DELETE = route(async (req) => {
  const { supabase } = await requireUser();
  const month = new URL(req.url).searchParams.get("month");
  if (!month) throw new ValidationError("month query parameter is required");

  const removed = await deleteBudget(supabase, assertMonthKey(month));
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: month });
});
