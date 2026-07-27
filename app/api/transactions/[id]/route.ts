import { NextResponse } from "next/server";
import { requireUser, route, readJson } from "@/lib/api-helpers";
import { getTransaction, updateTransaction, deleteTransaction } from "@/lib/repository";
import {
  assertUuid,
  assertAmountUSD,
  assertCategory,
  assertLocalDate,
  sanitizeNote,
  ValidationError,
} from "@/lib/validation";
import { toSpentOn } from "@/lib/mappers";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/transactions/:id */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { supabase } = await requireUser();
  const { id } = await params;

  const tx = await getTransaction(supabase, id);
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ transaction: tx });
});

/**
 * PATCH /api/transactions/:id
 * Body: any subset of { amountUSD, category, note, date }
 */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const { supabase } = await requireUser();
  const { id } = await params;
  const body = await readJson(req);

  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be an object");
  }
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (b.amountUSD !== undefined) patch.amount_usd = assertAmountUSD(b.amountUSD);
  if (b.category  !== undefined) patch.category   = assertCategory(b.category);
  if (b.note      !== undefined) patch.note       = sanitizeNote(b.note);
  if (b.date      !== undefined) {
    if (typeof b.date !== "string") throw new ValidationError("date must be a string");
    patch.spent_on = /^\d{4}-\d{2}-\d{2}$/.test(b.date)
      ? assertLocalDate(b.date)
      : toSpentOn(b.date);
    if (!patch.spent_on) throw new ValidationError("date is not a valid date");
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError("No updatable fields provided");
  }

  const updated = await updateTransaction(supabase, assertUuid(id), patch);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ transaction: updated });
});

/** DELETE /api/transactions/:id */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { supabase } = await requireUser();
  const { id } = await params;

  const removed = await deleteTransaction(supabase, assertUuid(id));
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: id });
});
