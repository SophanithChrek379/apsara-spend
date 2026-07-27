import { createClient } from "@/utils/supabase/client";

/**
 * Silent anonymous session.
 *
 * The app has no login screen, so on first open we mint an anonymous Supabase
 * user. It's a real user with a real uid, which is what lets RLS scope rows —
 * the publishable key alone grants nothing. createBrowserClient persists the
 * session to cookies, which is how the route handlers see the same identity.
 *
 * Requires "Allow anonymous sign-ins" to be enabled in the Supabase dashboard
 * (Authentication → Sign In / Providers). If it isn't, this resolves to null and
 * the app stays in cache-only mode rather than breaking.
 */

/**
 * Every auth call is bounded. supabase-js serialises auth work behind a Web
 * Lock, and a lock held by another tab (or a stale one left by a killed PWA
 * process) makes getSession() wait rather than fail. Since the ledger boot
 * awaits this, an unbounded wait means the app never leaves its loading state.
 */
const AUTH_TIMEOUT_MS = 8_000;

const withTimeout = <T>(work: Promise<T>, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${AUTH_TIMEOUT_MS}ms`)),
      AUTH_TIMEOUT_MS,
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err); },
    );
  });

let pending: Promise<string | null> | null = null;
let userId: string | null = null;

/** The uid resolved by the last successful ensureSession(), if any. */
export const currentUserId = (): string | null => userId;

export const ensureSession = (): Promise<string | null> => {
  if (pending) return pending;

  pending = (async () => {
    try {
      const supabase = createClient();

      const { data: existing } = await withTimeout(supabase.auth.getSession(), "getSession");
      if (existing.session?.user) return existing.session.user.id;

      const { data, error } = await withTimeout(
        supabase.auth.signInAnonymously(),
        "signInAnonymously",
      );
      if (error) {
        console.warn("[ledger] anonymous sign-in failed:", error.message);
        return null;
      }
      return data.user?.id ?? null;
    } catch (err) {
      console.warn("[ledger] session unavailable:", err);
      return null;
    }
  })();

  // Don't cache a failure — a later attempt (e.g. after reconnect) should retry.
  pending = pending.then((id) => {
    userId = id;
    if (id === null) pending = null;
    return id;
  });

  return pending;
};

/**
 * Recovery for a 401 from our own API while we believed we held a session:
 * the access token expired and neither the proxy nor the client had rotated it
 * yet. Forces the refresh, then re-reads what stuck.
 *
 * Deliberately never signs in anonymously. A fresh anonymous user owns no rows,
 * so minting one here would answer "your token is stale" with "here is an empty
 * ledger" — and the empty ledger is precisely what must not reach the UI. If the
 * refresh fails we return null and stay on the cache.
 */
export const recoverSession = async (): Promise<string | null> => {
  pending = null;

  try {
    const supabase = createClient();

    const refreshed = await withTimeout(supabase.auth.refreshSession(), "refreshSession");
    if (!refreshed.error && refreshed.data.session?.user) {
      userId = refreshed.data.session.user.id;
      return userId;
    }

    // refreshSession() fails when it has nothing to work from; the session may
    // still be valid if another tab rotated the cookie a moment ago.
    const { data } = await withTimeout(supabase.auth.getSession(), "getSession");
    if (data.session?.user) {
      userId = data.session.user.id;
      return userId;
    }
  } catch (err) {
    console.warn("[ledger] session recovery failed:", err);
  }

  userId = null;
  return null;
};
