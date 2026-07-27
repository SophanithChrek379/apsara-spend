"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppData, SyncOp, Transaction } from "@/lib/types";
import { MIGRATED_KEY } from "@/lib/constants";
import { readCache, writeCache, readSnapshot, writeSnapshot, defaultData } from "@/lib/ledger/cache";
import { diffLedger, isUuid } from "@/lib/ledger/diff";
import { ensureSession } from "@/lib/ledger/session";
import { fetchLedger, pushOps, ApiError } from "@/lib/ledger/api";

export type SyncStatus = "loading" | "synced" | "pending" | "offline" | "error";

/** crypto.randomUUID needs a secure context; this keeps http:// LAN testing working. */
const newUuid = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const newTransactionId = newUuid;

const DEBOUNCE_MS = 400;

/**
 * Owns the ledger. Drop-in replacement for the old
 * `useState<AppData>(() => loadData())` plus its debounced save effect:
 * `data` / `setData` behave exactly as before, so every caller — including the
 * undo closures that re-insert a deleted row — works untouched.
 *
 * Lifecycle on mount:
 *   1. paint from cache synchronously (frame one, no network)
 *   2. ensure an anonymous session
 *   3. one-time import of pre-existing localStorage data
 *   4. flush the pending diff, then pull authoritative state
 *
 * Steps 2–4 are best-effort. If any fails the app stays fully usable against
 * the cache and retries on reconnect, which is the whole point of keeping
 * localStorage in the loop.
 */
export function useSyncedLedger() {
  const initial = useRef<{ data: AppData; corrupted: boolean }>();
  if (!initial.current) {
    const { data, corrupted } = typeof window === "undefined"
      ? { data: null, corrupted: false }
      : readCache();
    initial.current = { data: data ?? defaultData(), corrupted };
  }

  const [data, setDataRaw]   = useState<AppData>(initial.current.data);
  const [isLoaded, setLoaded] = useState(false);
  const [status, setStatus]   = useState<SyncStatus>("loading");
  const [pendingCount, setPendingCount] = useState(0);
  const cacheCorrupted = initial.current.corrupted;

  // Bumped on every local write. A pull that started before the bump is stale
  // and must not overwrite what the user just did.
  const revRef      = useRef(0);
  const dataRef     = useRef(data);
  const snapshotRef = useRef<AppData>(readSnapshotSafe());
  const syncingRef  = useRef(false);
  const resyncRef   = useRef(false);
  const quotaWarnRef = useRef(false);

  dataRef.current = data;

  const setData = useCallback<React.Dispatch<React.SetStateAction<AppData>>>((update) => {
    revRef.current++;
    setDataRaw(update);
  }, []);

  /** Push pending ops, then adopt server state unless the user wrote meanwhile. */
  const sync = useCallback(async (opts: { pull?: boolean } = {}) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setStatus(diffLedger(snapshotRef.current, dataRef.current).length > 0 ? "pending" : "offline");
      return;
    }
    if (syncingRef.current) { resyncRef.current = true; return; }
    syncingRef.current = true;

    try {
      const userId = await ensureSession();
      if (!userId) { setStatus("offline"); return; }

      const revAtStart = revRef.current;
      const local      = dataRef.current;
      const ops        = diffLedger(snapshotRef.current, local);

      const { ledger } = await pushOps(ops, { pull: opts.pull !== false });

      if (ledger) {
        if (revRef.current === revAtStart) {
          // Nothing changed locally during the round trip — server is truth.
          snapshotRef.current = ledger;
          writeSnapshot(ledger);
          setDataRaw(ledger);
          writeCache(ledger);
          setPendingCount(0);
          setStatus("synced");
        } else {
          // User wrote mid-flight. The ops we sent are now in the server state,
          // so it's a valid snapshot — but don't clobber the newer local data.
          snapshotRef.current = ledger;
          writeSnapshot(ledger);
          resyncRef.current = true;
        }
      } else {
        snapshotRef.current = local;
        writeSnapshot(local);
        setPendingCount(0);
        setStatus("synced");
      }
    } catch (err) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (offline) setStatus("pending");
      else if (err instanceof ApiError && err.status === 401) setStatus("offline");
      else {
        console.warn("[ledger] sync failed:", err);
        setStatus("error");
      }
    } finally {
      syncingRef.current = false;
      if (resyncRef.current) {
        resyncRef.current = false;
        void sync({ pull: true });
      }
    }
  }, []);

  // ── Boot ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const userId = await ensureSession();
        if (cancelled) return;

        if (!userId) {
          setStatus("offline");
          return;
        }

        // One-time import of data written before the DB existed. Legacy ids are
        // `Date.now()+random` strings, not uuids, so they get rewritten here —
        // this is the only place ids change, and the cache is updated to match.
        // A corrupted cache is skipped rather than marked imported, so a later
        // good read still gets its chance to migrate.
        const alreadyImported = localStorage.getItem(MIGRATED_KEY) === "1";
        if (!alreadyImported && !initial.current!.corrupted) {
          const local = dataRef.current;
          const hasLocal =
            local.transactions.length > 0 || Object.keys(local.monthlyBalances).length > 0;

          if (hasLocal) {
            const remapped: Transaction[] = local.transactions.map((t) =>
              isUuid(t.id) ? t : { ...t, id: newUuid() },
            );
            const importOps: SyncOp[] = [
              ...remapped.map((tx): SyncOp => ({ type: "upsertTx", tx })),
              ...Object.entries(local.monthlyBalances).map(
                ([month, amount]): SyncOp => ({ type: "setBudget", month, amount }),
              ),
            ];

            const { ledger } = await pushOps(importOps, { pull: true });
            if (cancelled) return;

            localStorage.setItem(MIGRATED_KEY, "1");
            if (ledger) {
              snapshotRef.current = ledger;
              writeSnapshot(ledger);
              setDataRaw(ledger);
              writeCache(ledger);
              setStatus("synced");
              return;
            }
          } else {
            localStorage.setItem(MIGRATED_KEY, "1");
          }
        }

        // Normal path: flush anything pending, adopt server state.
        const pending = diffLedger(snapshotRef.current, dataRef.current);
        if (pending.length > 0) {
          await sync({ pull: true });
        } else {
          const ledger = await fetchLedger();
          if (cancelled) return;
          snapshotRef.current = ledger;
          writeSnapshot(ledger);
          setDataRaw(ledger);
          writeCache(ledger);
          setStatus("synced");
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[ledger] boot sync failed, using cache:", err);
          setStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
        }
      } finally {
        // Always release the splash — a failed sync must never trap the user.
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist + push on change (debounced, as the old save effect was) ─────
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isLoaded) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const ok = writeCache(data);
      if (!ok && !quotaWarnRef.current) {
        quotaWarnRef.current = true;
        console.warn("[ledger] cache write failed (quota) — data still syncs to the server");
      }

      const ops = diffLedger(snapshotRef.current, data);
      setPendingCount(ops.length);
      if (ops.length > 0) {
        setStatus("pending");
        void sync({ pull: true });
      }
    }, DEBOUNCE_MS);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [data, isLoaded, sync]);

  // ── Retry on reconnect / tab refocus ────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    const onOnline = () => void sync({ pull: true });
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync({ pull: true });
    };
    const onOffline = () => {
      setStatus(diffLedger(snapshotRef.current, dataRef.current).length > 0 ? "pending" : "offline");
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sync]);

  return {
    data,
    setData,
    isLoaded,
    status,
    pendingCount,
    cacheCorrupted,
    syncNow: useCallback(() => sync({ pull: true }), [sync]),
  };
}

function readSnapshotSafe(): AppData {
  if (typeof window === "undefined") return defaultData();
  return readSnapshot() ?? defaultData();
}
