import {
  CATEGORY_IDS,
  MAX_AMOUNT_USD,
  MAX_BUDGET_USD,
  type CategoryId,
  type Transaction,
} from "@/lib/types";

/**
 * Server-side validation. The client sanitises too, but a client is only a
 * suggestion — every field that reaches the DB is re-checked here. These rules
 * mirror the CHECK constraints in supabase/migrations/0001_ledger.sql so a bad
 * payload fails with a 400 and a readable message instead of a Postgres error.
 */

export class ValidationError extends Error {}

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

/** Strips the same characters as the client's sanitizeText, then hard-caps length. */
export const sanitizeNote = (s: unknown): string =>
  typeof s === "string" ? s.replace(/[<>"'`]/g, "").slice(0, 100) : "";

export const assertUuid = (v: unknown, field = "id"): string =>
  typeof v === "string" && UUID_RE.test(v) ? v : fail(`${field} must be a UUID`);

export const assertMonthKey = (v: unknown): string =>
  typeof v === "string" && MONTH_RE.test(v) ? v : fail("month must be formatted YYYY-MM");

export const assertCategory = (v: unknown): CategoryId =>
  typeof v === "string" && (CATEGORY_IDS as readonly string[]).includes(v)
    ? (v as CategoryId)
    : fail(`category must be one of: ${CATEGORY_IDS.join(", ")}`);

/** Rounds to 2dp the same way the client's pin2 does, then range-checks. */
export const assertAmountUSD = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) fail("amountUSD must be a number");
  const rounded = Math.round(n * 100) / 100;
  if (rounded <= 0)               fail("amountUSD must be greater than 0");
  if (rounded > MAX_AMOUNT_USD)   fail(`amountUSD must not exceed ${MAX_AMOUNT_USD}`);
  return rounded;
};

export const assertBudgetUSD = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n))      fail("amount must be a number");
  const rounded = Math.round(n * 100) / 100;
  if (rounded < 0)              fail("amount must not be negative");
  if (rounded > MAX_BUDGET_USD) fail(`amount must not exceed ${MAX_BUDGET_USD}`);
  return rounded;
};

/** "YYYY-MM-DD", and a real calendar date (rejects 2026-02-31). */
export const assertLocalDate = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    fail("date must be formatted YYYY-MM-DD");
  }
  const s = v as string;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    fail("date is not a valid calendar date");
  }
  return s;
};

/**
 * Validates an incoming transaction. `date` is accepted either as a local
 * calendar day ("YYYY-MM-DD") or as the ISO timestamp the existing client
 * produces; both normalise to a calendar day for storage.
 */
export const parseTransactionInput = (
  body: unknown,
  opts: { requireId?: boolean } = {},
): { tx: Transaction; spentOn: string } => {
  if (!body || typeof body !== "object") fail("request body must be an object");
  const b = body as Record<string, unknown>;

  const rawDate = b.date;
  let spentOn: string;
  if (typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    spentOn = assertLocalDate(rawDate);
  } else if (typeof rawDate === "string") {
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) fail("date is not a valid date");
    // Local components, matching lib/mappers.toSpentOn — see the note there.
    spentOn = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } else {
    fail("date is required");
    spentOn = "";
  }

  const category = assertCategory(b.category);

  return {
    tx: {
      id:        opts.requireId ? assertUuid(b.id) : (b.id === undefined ? "" : assertUuid(b.id)),
      amountUSD: assertAmountUSD(b.amountUSD),
      category,
      note:      sanitizeNote(b.note) || category,
      date:      new Date(`${spentOn}T00:00:00`).toISOString(),
    },
    spentOn,
  };
};
