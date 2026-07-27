import type { AppData, SyncOp, Transaction } from "@/lib/types";
import { SCHEMA_VERSION } from "@/lib/constants";

/**
 * Typed fetch wrappers over the route handlers. Same-origin, so the session
 * cookie rides along automatically and the CSP's connect-src 'self' covers it.
 */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Server op batches are capped; chunk so a big reset still flushes. */
const OPS_PER_BATCH = 200;

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* non-JSON error body */ }
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
};

export const fetchLedger = async (): Promise<AppData> => {
  const body = await request<AppData>("/api/ledger");
  return {
    schema_version:  SCHEMA_VERSION,
    transactions:    body.transactions ?? [],
    monthlyBalances: body.monthlyBalances ?? {},
  };
};

/**
 * Pushes ops and optionally pulls authoritative state back. Chunked, with the
 * pull requested only on the final batch so we read after every write landed.
 */
export const pushOps = async (
  ops: SyncOp[],
  opts: { pull?: boolean } = {},
): Promise<{ applied: number; ledger?: AppData }> => {
  if (ops.length === 0) {
    if (!opts.pull) return { applied: 0 };
    return { applied: 0, ledger: await fetchLedger() };
  }

  let applied = 0;
  let ledger: AppData | undefined;

  for (let i = 0; i < ops.length; i += OPS_PER_BATCH) {
    const chunk  = ops.slice(i, i + OPS_PER_BATCH);
    const isLast = i + OPS_PER_BATCH >= ops.length;

    const res = await request<{ applied: number; ledger?: AppData }>("/api/sync", {
      method: "POST",
      body: JSON.stringify({ ops: chunk, pull: isLast && opts.pull === true }),
    });

    applied += res.applied ?? 0;
    if (res.ledger) ledger = res.ledger;
  }

  return { applied, ledger };
};

// ── Single-resource CRUD ────────────────────────────────────────────────────
// The app's own writes go through the diff/sync path, but these are the
// documented REST surface and are what you'd call from any other client.

export const listTransactions = (month?: string) =>
  request<{ transactions: Transaction[] }>(
    month ? `/api/transactions?month=${encodeURIComponent(month)}` : "/api/transactions",
  ).then((r) => r.transactions);

export const createTransaction = (tx: Omit<Transaction, "id"> & { id?: string }) =>
  request<{ transaction: Transaction }>("/api/transactions", {
    method: "POST",
    body: JSON.stringify(tx),
  }).then((r) => r.transaction);

export const patchTransaction = (id: string, patch: Partial<Omit<Transaction, "id">>) =>
  request<{ transaction: Transaction }>(`/api/transactions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }).then((r) => r.transaction);

export const removeTransaction = (id: string) =>
  request<{ deleted: string }>(`/api/transactions/${id}`, { method: "DELETE" });

export const resetMonth = (month: string) =>
  request<{ deleted: number }>(`/api/transactions?month=${encodeURIComponent(month)}`, {
    method: "DELETE",
  });

export const listBudgets = () =>
  request<{ monthlyBalances: Record<string, number> }>("/api/budgets").then(
    (r) => r.monthlyBalances,
  );

export const putBudget = (month: string, amount: number) =>
  request<{ budget: { month: string; amount: number } }>("/api/budgets", {
    method: "PUT",
    body: JSON.stringify({ month, amount }),
  }).then((r) => r.budget);

export const removeBudget = (month: string) =>
  request<{ deleted: string }>(`/api/budgets?month=${encodeURIComponent(month)}`, {
    method: "DELETE",
  });
