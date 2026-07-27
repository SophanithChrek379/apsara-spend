import type { AppData, Transaction } from "@/lib/types";
import { SCHEMA_VERSION, STORAGE_KEY } from "@/lib/constants";
import { canonicalizeIso } from "@/lib/calendar-day";

/**
 * localStorage is now a read-through cache, not the source of truth. Two slots:
 *
 *   STORAGE_KEY   — what the UI last showed. Read synchronously on mount so the
 *                   PWA paints real data on frame one, with or without a network.
 *   SNAPSHOT_KEY  — the last state we know the server agreed with. Diffing the
 *                   cache against this yields the pending write set, which is
 *                   how offline edits survive a reload.
 *
 * The tx_count sentinel and version check are carried over from the original
 * storage layer so a half-finished write is still detected as corruption.
 */

const SNAPSHOT_KEY = `${STORAGE_KEY}__synced`;

/**
 * The uid the two slots above belong to. Anonymous identities are per-browser
 * and can be replaced (cookies cleared, refresh token revoked), and the new
 * identity owns nothing server-side. Without this we cannot tell "the server
 * says you have no expenses" from "you are now a different user" — and the two
 * demand opposite handling: adopt the empty state, or re-upload the cache.
 */
const USER_KEY = `${STORAGE_KEY}__user`;

export const defaultData = (): AppData => ({
  schema_version: SCHEMA_VERSION,
  transactions: [],
  monthlyBalances: {},
});

export const isValidAppData = (val: unknown): val is AppData => {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.transactions)) return false;
  if (obj.monthlyBalances !== undefined && typeof obj.monthlyBalances !== "object") return false;
  if (obj.schema_version !== undefined && typeof obj.schema_version !== "number") return false;
  return true;
};

/**
 * Rewrites a legacy local-midnight `date` to the canonical noon-UTC form.
 *
 * Applied to BOTH slots. Migrating only the cache would leave every row looking
 * different from its snapshot, and the diff would read that as an edit and
 * re-push the entire ledger on the next flush.
 */
const canonicalizeDate = (t: Transaction): Transaction => {
  const date = canonicalizeIso(t.date);
  return date === t.date ? t : { ...t, date };
};

const readSlot = (key: string): { data: AppData | null; corrupted: boolean } => {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
    if (!raw) return { data: null, corrupted: false };

    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Integrity check: a written tx_count that disagrees with the array length
    // means the write was truncated mid-flight.
    const storedCount = parsed.tx_count;
    const txArray     = parsed.transactions;
    if (typeof storedCount === "number" && Array.isArray(txArray) && storedCount !== txArray.length) {
      return { data: null, corrupted: true };
    }

    if (!isValidAppData(parsed)) return { data: null, corrupted: true };

    return {
      data: {
        schema_version:  SCHEMA_VERSION,
        transactions:    (parsed.transactions as Transaction[]).map(canonicalizeDate),
        monthlyBalances: (parsed.monthlyBalances as Record<string, number>) ?? {},
      },
      corrupted: false,
    };
  } catch {
    return { data: null, corrupted: true };
  }
};

const writeSlot = (key: string, data: AppData): boolean => {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ ...data, schema_version: SCHEMA_VERSION, tx_count: data.transactions.length }),
    );
    return true;
  } catch {
    return false; // quota exceeded
  }
};

export const readCache     = () => readSlot(STORAGE_KEY);
export const writeCache    = (data: AppData) => writeSlot(STORAGE_KEY, data);
export const readSnapshot  = () => readSlot(SNAPSHOT_KEY).data;
export const writeSnapshot = (data: AppData) => writeSlot(SNAPSHOT_KEY, data);

export const readUserId = (): string | null => {
  try {
    return typeof window !== "undefined" ? localStorage.getItem(USER_KEY) : null;
  } catch {
    return null;
  }
};

export const writeUserId = (id: string): void => {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch { /* quota — identity check degrades, nothing else */ }
};
