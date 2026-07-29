"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppData } from "@/lib/types";
import { MIGRATED_KEY } from "@/lib/constants";
import {
  readCache, writeCache,
  readSnapshot, writeSnapshot,
  readUserId, writeUserId,
  clearLedgerCache,
  defaultData,
} from "@/lib/ledger/cache";
import { diffLedger, reconcileLedger, pushedState, isUuid, type PushedState } from "@/lib/ledger/diff";
import { ensureSession, recoverSession } from "@/lib/ledger/session";
import { readAccount, takeOAuthIntent, type Account, type OAuthIntent } from "@/lib/ledger/account";
import { pushOps, ApiError } from "@/lib/ledger/api";

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

/** Delays between the boot reconcile's attempts. One cold open, three chances. */
const BOOT_RETRY_DELAYS_MS = [800, 2_400];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface InitialState {
  data: AppData;
  snapshot: AppData;
  corrupted: boolean;
}

/**
 * Reads both localStorage slots once, and resolves the one combination that
 * cannot be taken at face value.
 *
 * A cache that yielded nothing (missing or unreadable) next to a snapshot that
 * holds rows does NOT mean the user deleted everything: diffing the empty
 * ledger against that snapshot emits a delete per row, and flushing it wipes
 * the server. Dropping the snapshot here — before any effect, any render and
 * any network call — makes that diff unrepresentable, so no code path can push
 * a wipe derived from a lost cache even if every request fails. A genuine
 * delete-all leaves a *valid* cache holding zero rows and still syncs normally.
 */
const readInitialState = (): InitialState => {
  if (typeof window === "undefined") {
    return { data: defaultData(), snapshot: defaultData(), corrupted: false };
  }

  const { data, corrupted } = readCache();
  let snapshot = readSnapshot() ?? defaultData();

  const snapshotHasRows =
    snapshot.transactions.length > 0 || Object.keys(snapshot.monthlyBalances).length > 0;

  if (data === null && snapshotHasRows) {
    console.warn("[ledger] cache lost but snapshot has rows — dropping the snapshot so the server state is pulled, never deleted");
    snapshot = defaultData();
    writeSnapshot(snapshot);
  }

  return { data: data ?? defaultData(), snapshot, corrupted };
};

/**
 * Owns the ledger. Drop-in replacement for the old
 * `useState<AppData>(() => loadData())` plus its debounced save effect:
 * `data` / `setData` behave exactly as before, so every caller — including the
 * undo closures that re-insert a deleted row — works untouched.
 *
 * Lifecycle on mount:
 *   1. paint from cache synchronously (frame one, no network)
 *   2. release the UI — `isLoaded` is about the cache read, never the network
 *   3. ensure an anonymous session, remap pre-database ids
 *   4. flush the pending diff and merge the authoritative state in, retrying
 *
 * Steps 3–4 are best-effort. If any fails the app stays fully usable against
 * the cache and retries on reconnect, which is the whole point of keeping
 * localStorage in the loop.
 */
export function useSyncedLedger() {
  const initial = useRef<InitialState>();
  if (!initial.current) initial.current = readInitialState();

  const [data, setDataRaw]   = useState<AppData>(initial.current.data);
  const [isLoaded, setLoaded] = useState(false);
  const [status, setStatus]   = useState<SyncStatus>("loading");
  const [pendingCount, setPendingCount] = useState(0);
  const [account, setAccount] = useState<Account | null>(null);
  /**
   * Set once, on the boot that follows a Google redirect that actually landed.
   * OAuth navigates away, so there is no promise left for the button to await
   * and nothing to report success from — without this the user returns to the
   * dashboard with no confirmation that anything happened.
   */
  const [oauthCompleted, setOAuthCompleted] = useState<OAuthIntent | null>(null);
  const cacheCorrupted = initial.current.corrupted;

  // Bumped on every local write, so a pull can tell whether the user changed
  // something during the round trip and queue another flush.
  const revRef      = useRef(0);
  const dataRef     = useRef(data);
  const snapshotRef = useRef<AppData>(initial.current.snapshot);
  const syncingRef  = useRef(false);
  const resyncRef   = useRef(false);
  const quotaWarnRef = useRef(false);
  // Declared here rather than beside its effect so the identity-switch
  // callbacks above can cancel a queued flush before wiping the cache.
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  dataRef.current = data;

  const setData = useCallback<React.Dispatch<React.SetStateAction<AppData>>>((update) => {
    revRef.current++;
    setDataRaw(update);
  }, []);

  /**
   * Release the shell as soon as we are mounted. The cache is already in state,
   * so there is nothing left to wait for — and waiting for the network is what
   * used to leave every month showing skeletons: `isLoaded` only flipped after
   * the boot round trip settled, and a stalled request never settles. Network
   * state belongs in `status`, which the sync pill renders, not in the gate that
   * decides whether the user may see their own expenses.
   */
  useEffect(() => { setLoaded(true); }, []);

  /**
   * Merge authoritative server state into what the user is looking at, and
   * persist both. Never a wholesale replace — see reconcileLedger. `pushed` is
   * what this round trip sent, which is what lets the merge tell a stale local
   * row from one the server has already answered on.
   */
  const adopt = useCallback((server: AppData, pushed?: PushedState) => {
    const merged = reconcileLedger(server, dataRef.current, snapshotRef.current, pushed);

    snapshotRef.current = server;
    writeSnapshot(server);
    dataRef.current = merged; // refs sync on render; callers below read it now
    setDataRaw(merged);
    writeCache(merged);

    const remaining = diffLedger(server, merged).length;
    setPendingCount(remaining);
    setStatus(remaining > 0 ? "pending" : "synced");
    if (remaining > 0) resyncRef.current = true;
  }, []);

  /**
   * A replaced anonymous identity (cookies cleared, refresh token revoked) owns
   * no rows, so its ledger reads as empty. Clearing the snapshot turns that from
   * "adopt an empty ledger over the cache" into "re-upload the cache under the
   * new uid" — the local data is the same data either way, and it stays visible.
   */
  const adoptIdentity = useCallback((userId: string) => {
    const known = readUserId();
    if (known === userId) return;

    if (known) {
      console.warn("[ledger] anonymous identity changed — re-uploading the local ledger under the new user");
      snapshotRef.current = defaultData();
      writeSnapshot(snapshotRef.current);
    }
    writeUserId(userId);
  }, []);

  /**
   * A 401 from our own API means the access token went stale — the app was
   * backgrounded past its expiry, or the proxy and the client raced to rotate
   * it. Refresh and try once. Without this the ledger falls back to the cache
   * for the rest of the session even though the server is reachable and holds
   * the data. Replayed ops are idempotent, so a partially applied batch is safe.
   */
  const pushWithAuthRetry = useCallback(async (ops: Parameters<typeof pushOps>[0], pull: boolean) => {
    try {
      return await pushOps(ops, { pull });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      const recovered = await recoverSession();
      if (!recovered) throw err;
      return await pushOps(ops, { pull });
    }
  }, []);

  /** Push pending ops, then merge server state back in. */
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
      adoptIdentity(userId);

      const revAtStart = revRef.current;
      const local      = dataRef.current;
      const ops        = diffLedger(snapshotRef.current, local);

      const { ledger } = await pushWithAuthRetry(ops, opts.pull !== false);

      if (ledger) {
        adopt(ledger, pushedState(ops));
        // The ops we sent are in that response, so anything the user changed
        // mid-flight is still pending and needs another round.
        if (revRef.current !== revAtStart) resyncRef.current = true;
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
  }, [adopt, adoptIdentity, pushWithAuthRetry]);

  // ── Account (Google on top of the anonymous session) ─────────────────────

  /** Re-reads who Supabase says we are. Safe to call after any auth action. */
  const refreshAccount = useCallback(async () => {
    const next = await readAccount();
    setAccount(next);
    return next;
  }, []);

  /**
   * Hand this device over to a DIFFERENT identity — the log-in path.
   *
   * Signing up keeps the same uid and must NOT come through here: it needs the
   * cache preserved, which is the entire point of upgrading in place.
   *
   * Everything local is dropped before the pull, in this order:
   *   1. snapshot → empty, so no pending diff exists to be flushed
   *   2. data → empty, so the debounced effect computes zero ops
   *   3. localStorage → cleared, so a reload mid-flight can't resurrect it
   *
   * Clearing the snapshot alone would be worse than doing nothing: the diff
   * would read the previous occupant's rows as new writes and upload them into
   * the account being logged into. With both sides empty, reconcileLedger
   * returns the server ledger verbatim.
   *
   * The old anonymous user's rows stay in Postgres under their own uid. They are
   * unreachable (RLS scopes every read to auth.uid()) and harmless.
   */
  const adoptAccount = useCallback(async (accountUserId: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const empty = defaultData();
    snapshotRef.current = empty;
    dataRef.current     = empty;
    clearLedgerCache();
    setDataRaw(empty);
    setPendingCount(0);
    setStatus("loading");
    writeUserId(accountUserId);

    await refreshAccount();
    return sync({ pull: true });
  }, [refreshAccount, sync]);

  /**
   * Post sign-out cleanup. The session is already gone by the time this runs;
   * what's left is to make sure the next person to open the app on this device
   * gets a fresh anonymous identity rather than the previous account's ledger.
   */
  const resetToAnonymous = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const empty = defaultData();
    snapshotRef.current = empty;
    dataRef.current     = empty;
    clearLedgerCache();
    setDataRaw(empty);
    setPendingCount(0);
    setStatus("loading");

    const newUserId = await ensureSession();
    if (newUserId) writeUserId(newUserId);
    await refreshAccount();
    return sync({ pull: true });
  }, [refreshAccount, sync]);

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

        // Back from a Google redirect, maybe. The intent is consumed on every
        // boot so a stale one can never survive to wipe a later session.
        //
        // Only a login that actually landed on a DIFFERENT uid triggers the
        // hard reset. A link keeps the anonymous uid and falls through with the
        // cache intact, and so does a cancelled login — which is the whole
        // reason this is guarded on the uid rather than on the intent alone.
        const oauthIntent = takeOAuthIntent();
        if (oauthIntent === "login" && readUserId() !== userId) {
          setOAuthCompleted("login");
          await adoptAccount(userId);
          return;
        }

        adoptIdentity(userId);
        const linked = await refreshAccount();

        // Only report a link that actually took. Cancelling at Google's consent
        // screen returns on the same anonymous uid, so `isAnonymous` is what
        // separates "linked" from "changed their mind" — the intent alone
        // cannot, and claiming success on a cancel would be a lie the Settings
        // panel immediately contradicts.
        if (oauthIntent === "signup" && linked && !linked.isAnonymous) {
          setOAuthCompleted("signup");
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

        // Pre-existing data is just a pending diff against an empty snapshot —
        // the same path an offline backlog takes. No special-cased import, so
        // there is one less way for this to go wrong.
        //
        // Retried, because this is the round trip that decides whether the user
        // sees the server's ledger at all, and a cold open on a flaky mobile
        // connection is exactly when it fails. Only a genuine error is retried:
        // offline and unauthenticated are handled by the reconnect listeners,
        // and "busy" means a flush is already running and will resync.
        for (let attempt = 0; !cancelled; attempt++) {
          const result = await sync({ pull: true });
          if (result.ok || result.reason !== "error") break;
          if (attempt >= BOOT_RETRY_DELAYS_MS.length) break;
          await sleep(BOOT_RETRY_DELAYS_MS[attempt]);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[ledger] boot sync failed, using cache:", err);
          setStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist + push on change (debounced, as the old save effect was) ─────
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
    // Account surface. `account` is null until the boot session resolves, so
    // treat null as "still anonymous" rather than "signed out".
    account,
    refreshAccount,
    adoptAccount,
    resetToAnonymous,
    oauthCompleted,
    clearOAuthCompleted: useCallback(() => setOAuthCompleted(null), []),
  };
}
