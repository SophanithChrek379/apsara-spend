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

/**
 * The values a round trip just sent, so the response to them can be trusted.
 * Built from the op list by the caller — see reconcileLedger.
 */
export interface PushedState {
  transactions: Map<string, Transaction>;
  budgets: Map<string, number>;
}

export const pushedState = (ops: SyncOp[]): PushedState => {
  const transactions = new Map<string, Transaction>();
  const budgets      = new Map<string, number>();
  for (const op of ops) {
    if (op.type === "upsertTx")  transactions.set(op.tx.id, op.tx);
    if (op.type === "setBudget") budgets.set(op.month, op.amount);
  }
  return { transactions, budgets };
};

/**
 * What the UI should show after a pull: a three-way merge of the server state,
 * the local state and the last state the two agreed on.
 *
 * Replacing local state with the server response outright is only correct while
 * the two are in sync. Anything the user changed since that agreed state —
 * including a delete — is a write the server hasn't seen yet, and overwriting it
 * loses real data. That is how a pull answering with fewer rows than the cache
 * held could blank the ledger: the response was adopted wholesale.
 *
 * Per id, the reference for "did the user change this?" is the newest value the
 * server is known to have been told about — the value we just pushed if this
 * round pushed one, otherwise the snapshot:
 *   - local differs from the reference → un-pushed local write, local wins
 *   - local matches the reference      → server wins, deletion included
 *   - in the snapshot, gone locally    → un-pushed local delete, stays deleted
 *
 * Preferring the pushed value over the snapshot is what makes this converge: if
 * the server stores something other than what it was sent (a sanitised note, a
 * rounded amount), local matches what we pushed, so the server's version is
 * adopted and the next diff is empty. Comparing against the stale snapshot
 * instead would mark the row dirty forever and sync in a loop.
 *
 * An empty snapshot with nothing pushed means "keep everything local and
 * re-upload it", which is what the caller wants after the cache is lost or the
 * anonymous identity is replaced.
 */
export const reconcileLedger = (
  server: AppData,
  local: AppData,
  snapshot: AppData,
  pushed?: PushedState,
): AppData => {
  const before   = new Map(snapshot.transactions.map((t) => [t.id, t]));
  const localTx  = new Map(local.transactions.map((t) => [t.id, t]));
  const merged   = new Map(server.transactions.map((t) => [t.id, t]));

  for (const [id, tx] of localTx) {
    const reference = pushed?.transactions.get(id) ?? before.get(id);
    if (!reference || !sameTx(reference, tx)) merged.set(id, tx); // un-pushed local write
  }

  for (const id of before.keys()) {
    if (!localTx.has(id)) merged.delete(id); // un-pushed local delete
  }

  const balances: Record<string, number> = { ...server.monthlyBalances };

  for (const [month, amount] of Object.entries(local.monthlyBalances)) {
    const reference = pushed?.budgets.has(month)
      ? pushed.budgets.get(month)
      : snapshot.monthlyBalances[month];
    if (reference !== amount) balances[month] = amount;
  }

  for (const month of Object.keys(snapshot.monthlyBalances)) {
    if (!(month in local.monthlyBalances)) delete balances[month];
  }

  return {
    schema_version:  server.schema_version,
    transactions:    Array.from(merged.values()),
    monthlyBalances: balances,
  };
};
