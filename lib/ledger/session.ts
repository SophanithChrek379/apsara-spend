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

let pending: Promise<string | null> | null = null;

export const ensureSession = (): Promise<string | null> => {
  if (pending) return pending;

  pending = (async () => {
    try {
      const supabase = createClient();

      const { data: existing } = await supabase.auth.getSession();
      if (existing.session?.user) return existing.session.user.id;

      const { data, error } = await supabase.auth.signInAnonymously();
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
    if (id === null) pending = null;
    return id;
  });

  return pending;
};
