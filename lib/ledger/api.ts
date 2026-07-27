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

/**
 * The request never produced a response — DNS/offline, a dropped connection, or
 * a stall that hit the timeout. Distinct from ApiError because it carries no
 * status and is always worth retrying.
 */
export class NetworkError extends Error {
  constructor(message: string, readonly timedOut = false) {
    super(message);
  }
}

/** Server op batches are capped; chunk so a big reset still flushes. */
const OPS_PER_BATCH = 200;

/**
 * Hard ceiling on every call. A mobile radio that accepts the connection and
 * then stalls leaves `fetch` pending indefinitely — no error, no response. The
 * boot pull used to await exactly that, so a single stalled request could keep
 * the ledger in its loading state for as long as the app stayed open. Nothing
 * here may hang: a timeout that surfaces as a retryable error is always better
 * than a promise that never settles.
 */
const REQUEST_TIMEOUT_MS = 12_000;

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch { /* non-JSON error body */ }
      throw new ApiError(message, res.status);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new NetworkError(
      timedOut
        ? `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      timedOut,
    );
  } finally {
    clearTimeout(timer);
  }
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
