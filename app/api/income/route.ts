import { NextResponse } from "next/server";
import { requireUser, route, readJson } from "@/lib/api-helpers";
import { listIncome, setIncome, deleteIncome } from "@/lib/repository";
import { assertYear, assertIncomeUSD, ValidationError } from "@/lib/validation";

/**
 * GET /api/income
 * → { income: { "2026": 8354.02, ... } }
 *
 * Not part of /api/ledger: the client asks for this only after its Face ID
 * gate opens, and never caches the answer.
 */
export const GET = route(async () => {
  const { supabase } = await requireUser();
  const income = await listIncome(supabase);
  return NextResponse.json({ income }, { headers: { "Cache-Control": "no-store" } });
});

/**
 * PUT /api/income
 * Body: { year: number, amount: number }
 *
 * Idempotent upsert on (user, year) — a raise mid-year is a revision of that
 * year's figure, not a second row.
 */
export const PUT = route(async (req) => {
  const { supabase, user } = await requireUser();
  const body = await readJson(req);

  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be an object");
  }
  const b = body as Record<string, unknown>;

  const saved = await setIncome(supabase, user.id, assertYear(b.year), assertIncomeUSD(b.amount));
  return NextResponse.json({ income: saved });
});

/** DELETE /api/income?year=YYYY */
export const DELETE = route(async (req) => {
  const { supabase } = await requireUser();
  const year = new URL(req.url).searchParams.get("year");
  if (!year) throw new ValidationError("year query parameter is required");

  const removed = await deleteIncome(supabase, assertYear(year));
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: Number(year) });
});
