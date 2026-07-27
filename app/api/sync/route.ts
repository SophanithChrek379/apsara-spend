import { NextResponse } from "next/server";
import { requireUser, route, readJson } from "@/lib/api-helpers";
import { applyOps, fetchLedger } from "@/lib/repository";
import { parseTransactionInput, assertMonthKey, assertUuid, assertBudgetUSD, ValidationError } from "@/lib/validation";
import { SCHEMA_VERSION } from "@/lib/constants";
import type { SyncOp } from "@/lib/types";

/** Hard cap so a corrupted outbox can't submit an unbounded batch. */
const MAX_OPS = 500;

/**
 * Every op is re-validated here rather than trusted. The outbox is localStorage,
 * which is user-writable, so an op list is untrusted input like any other body.
 */
const parseOps = (body: unknown): SyncOp[] => {
  if (!body || typeof body !== "object") throw new ValidationError("Request body must be an object");
  const raw = (body as { ops?: unknown }).ops;
  if (!Array.isArray(raw)) throw new ValidationError("ops must be an array");
  if (raw.length > MAX_OPS) throw new ValidationError(`ops must contain at most ${MAX_OPS} entries`);

  return raw.map((entry, i): SyncOp => {
    if (!entry || typeof entry !== "object") {
      throw new ValidationError(`ops[${i}] must be an object`);
    }
    const op = entry as Record<string, unknown>;
    switch (op.type) {
      case "upsertTx": {
        const { tx } = parseTransactionInput(op.tx, { requireId: true });
        return { type: "upsertTx", tx };
      }
      case "deleteTx":
        return { type: "deleteTx", id: assertUuid(op.id) };
      case "setBudget":
        return { type: "setBudget", month: assertMonthKey(op.month), amount: assertBudgetUSD(op.amount) };
      case "deleteBudget":
        return { type: "deleteBudget", month: assertMonthKey(op.month) };
      case "resetMonth":
        return { type: "resetMonth", month: assertMonthKey(op.month) };
      default:
        throw new ValidationError(`ops[${i}].type is not a known operation`);
    }
  });
};

/**
 * POST /api/sync
 * Body: { ops: SyncOp[], pull?: boolean }
 *
 * Drains the client's offline write queue in one round trip, and is also the
 * path the one-time localStorage import uses. With pull:true the authoritative
 * ledger comes back in the same response, so the client can reconcile without
 * a follow-up GET.
 */
export const POST = route(async (req) => {
  const { supabase, user } = await requireUser();
  const body = await readJson(req);

  const ops = parseOps(body);
  const { applied } = await applyOps(supabase, user.id, ops);

  const wantsPull = (body as { pull?: unknown }).pull === true;
  if (!wantsPull) return NextResponse.json({ applied });

  const { transactions, monthlyBalances } = await fetchLedger(supabase);
  return NextResponse.json({
    applied,
    ledger: { schema_version: SCHEMA_VERSION, transactions, monthlyBalances },
  });
});
