import type { AppData, SyncOp, Transaction } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (id: string) => UUID_RE.test(id);

const sameTx = (a: Transaction, b: Transaction) =>
  a.amountUSD === b.amountUSD &&
  a.category  === b.category  &&
  a.note      === b.note      &&
  a.date      === b.date;

/**
 * Pending write set = whatever makes `snapshot` look like `current`.
 *
 * Deriving ops from a diff rather than appending to a queue means the pending
 * set is always a pure function of (last synced state, current state). A write
 * can't be double-applied, an undo cancels itself out to nothing, and a reload
 * mid-offline recomputes the identical set from localStorage.
 */
export const diffLedger = (snapshot: AppData, current: AppData): SyncOp[] => {
  const ops: SyncOp[] = [];

  const before = new Map(snapshot.transactions.map((t) => [t.id, t]));
  const after  = new Map(current.transactions.map((t) => [t.id, t]));

  for (const [id, tx] of after) {
    // Legacy non-uuid ids predate the DB and would be rejected by the schema.
    // The one-time import rewrites them; skip rather than poison every flush.
    if (!isUuid(id)) continue;
    const prev = before.get(id);
    if (!prev || !sameTx(prev, tx)) ops.push({ type: "upsertTx", tx });
  }

  for (const id of before.keys()) {
    if (!after.has(id) && isUuid(id)) ops.push({ type: "deleteTx", id });
  }

  for (const [month, amount] of Object.entries(current.monthlyBalances)) {
    if (snapshot.monthlyBalances[month] !== amount) {
      ops.push({ type: "setBudget", month, amount });
    }
  }

  for (const month of Object.keys(snapshot.monthlyBalances)) {
    if (!(month in current.monthlyBalances)) {
      ops.push({ type: "deleteBudget", month });
    }
  }

  return ops;
};

/** True when the two states are identical as far as the server is concerned. */
export const inSync = (snapshot: AppData, current: AppData) =>
  diffLedger(snapshot, current).length === 0;
