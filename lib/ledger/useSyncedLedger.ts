"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppData } from "@/lib/types";
import { MIGRATED_KEY } from "@/lib/constants";
import { readCache, writeCache, readSnapshot, writeSnapshot, defaultData } from "@/lib/ledger/cache";
import { diffLedger, isUuid } from "@/lib/ledger/diff";
import { ensureSession } from "@/lib/ledger/session";
import { fetchLedger, pushOps, ApiError } from "@/lib/ledger/api";

export type SyncStatus = "loading" | "synced" | "pending" | "offline" | "error";

/**
 * What a manual "Sync now" tap resolves to, so the UI can report something
 * concrete ("143 entries in the cloud") instead of a generic spinner.
 */
export interface SyncResult {
  ok: boolean;
  /** Ops actually sent this round. 0 with ok:true means "already up to date". */
  pushed: number;
  /** Transactions the server holds afterwards. */
  total: number;
  reason?: "offline" | "unauthenticated" | "busy" | "error";
}

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
  const initial = useRef<{ data: AppData; corrupted: boolean; absent: boolean }>();
  if (!initial.current) {
    const { data, corrupted } = typeof window === "undefined"
      ? { data: null, corrupted: false }
      : readCache();
    // `absent` = the cache slot yielded nothing, whether missing or unreadable.
    // Distinct from "read fine and holds zero rows", which is a legitimate state
    // (the user deleted everything) and must still be allowed to sync.
    initial.current = { data: data ?? defaultData(), corrupted, absent: data === null };
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
  const sync = useCallback(async (opts: { pull?: boolean } = {}): Promise<SyncResult> => {
    const localTotal = () => dataRef.current.transactions.length;

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const pending = diffLedger(snapshotRef.current, dataRef.current).length;
      setStatus(pending > 0 ? "pending" : "offline");
      return { ok: false, pushed: 0, total: localTotal(), reason: "offline" };
    }
    if (syncingRef.current) {
      resyncRef.current = true;
      return { ok: false, pushed: 0, total: localTotal(), reason: "busy" };
    }
    syncingRef.current = true;

    try {
      const userId = await ensureSession();
      if (!userId) {
        setStatus("offline");
        return { ok: false, pushed: 0, total: localTotal(), reason: "unauthenticated" };
      }

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
        return { ok: true, pushed: ops.length, total: ledger.transactions.length };
      }

      snapshotRef.current = local;
      writeSnapshot(local);
      setPendingCount(0);
      setStatus("synced");
      return { ok: true, pushed: ops.length, total: local.transactions.length };
    } catch (err) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (offline) setStatus("pending");
      else if (err instanceof ApiError && err.status === 401) setStatus("offline");
      else {
        console.warn("[ledger] sync failed:", err);
        setStatus("error");
      }
      return {
        ok: false,
        pushed: 0,
        total: localTotal(),
        reason: offline ? "offline" : err instanceof ApiError && err.status === 401 ? "unauthenticated" : "error",
      };
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

        // One-time id remap for data written before the DB existed. Legacy ids
        // are `Date.now()+random` strings, which cannot be uuid primary keys.
        //
        // The remap is persisted to the cache BEFORE anything is pushed, and the
        // flag is set immediately. That ordering is the whole trick: if the push
        // then fails partway, the retry reuses the SAME uuids and every upsert is
        // idempotent. Minting fresh uuids on each attempt would re-insert every
        // row that already landed, duplicating the ledger.
        //
        // A corrupted cache is skipped rather than marked migrated, so a later
        // good read still gets its chance.
        if (localStorage.getItem(MIGRATED_KEY) !== "1" && !initial.current!.corrupted) {
          const local = dataRef.current;
          const needsRemap = local.transactions.some((t) => !isUuid(t.id));

          if (needsRemap) {
            const remapped: AppData = {
              ...local,
              transactions: local.transactions.map((t) =>
                isUuid(t.id) ? t : { ...t, id: newUuid() },
              ),
            };
            writeCache(remapped);
            dataRef.current = remapped; // refs update on render; this is pre-render
            setDataRaw(remapped);
          }

          localStorage.setItem(MIGRATED_KEY, "1");
        }

        // A cache that read as nothing is NOT "the user deleted everything".
        // Diffing an empty ledger against a populated snapshot emits a deleteTx
        // per row and would wipe the server on the next flush. A genuine
        // delete-all leaves a *valid* cache holding zero rows, which still
        // syncs normally — only a missing or corrupt slot lands here.
        const snapshotHasRows =
          snapshotRef.current.transactions.length > 0 ||
          Object.keys(snapshotRef.current.monthlyBalances).length > 0;

        if (initial.current!.absent && snapshotHasRows) {
          console.warn("[ledger] cache lost but snapshot has rows — pulling instead of pushing deletes");
          const ledger = await fetchLedger();
          if (cancelled) return;
          snapshotRef.current = ledger;
          writeSnapshot(ledger);
          setDataRaw(ledger);
          writeCache(ledger);
          setStatus("synced");
          return;
        }

        // Pre-existing data is now just a pending diff against an empty
        // snapshot — the same path an offline backlog takes. No special-cased
        // import, so there is one less way for this to go wrong.
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
