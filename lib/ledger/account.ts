import { createClient } from "@/utils/supabase/client";
import { resetSessionCache } from "@/lib/ledger/session";

/**
 * Email + OTP accounts on top of the anonymous session.
 *
 * Two distinct flows, and the difference between them is the whole reason this
 * file exists:
 *
 *   SIGN UP ("Sync")  — the visitor already IS a Supabase user (anonymous), and
 *                       owns rows. Attaching an email with updateUser() keeps
 *                       the SAME uid, so every transaction carries over with no
 *                       migration, no re-upload, nothing to reconcile.
 *
 *   LOG IN            — a different identity replaces this device's anonymous
 *                       one. The uid CHANGES, which means the local cache
 *                       belongs to a stranger and must be discarded, not
 *                       merged. That discard lives in useSyncedLedger's
 *                       adoptAccount(); this file only reports the new uid.
 *
 * Every call returns a discriminated result rather than throwing. Auth failures
 * here are ordinary user-facing outcomes ("that code expired"), not exceptions.
 */

export type AuthFailure =
  | "email_taken"      // sign-up: that address already has an account
  | "no_account"       // log-in: nothing registered under that address
  | "rate_limited"     // too many sends; Supabase's per-hour email cap
  | "bad_code"         // wrong or expired OTP
  | "offline"
  | "unknown";

export type AuthResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; failure: AuthFailure; message: string };

const MESSAGES: Record<AuthFailure, string> = {
  email_taken:  "That email already has an account.",
  no_account:   "No account found for that email.",
  rate_limited: "Too many codes requested. Try again in a few minutes.",
  bad_code:     "That code is wrong or has expired.",
  offline:      "You're offline. Reconnect and try again.",
  unknown:      "Something went wrong. Please try again.",
};

const fail = (failure: AuthFailure, override?: string): AuthResult<never> => ({
  ok: false,
  failure,
  message: override ?? MESSAGES[failure],
});

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Supabase error codes are stable and documented; the message strings are not.
 * Match on `code` and fall back to a substring probe only for older gateway
 * responses that predate the code field.
 */
const classify = (err: { code?: string; status?: number; message?: string } | null): AuthFailure => {
  if (!err) return "unknown";
  const code = err.code ?? "";
  const msg  = (err.message ?? "").toLowerCase();

  if (code === "email_exists" || code === "identity_already_exists") return "email_taken";
  if (code === "otp_disabled" || code === "user_not_found")          return "no_account";
  if (code === "over_email_send_rate_limit" || err.status === 429)   return "rate_limited";
  if (code === "otp_expired" || code === "invalid_credentials")      return "bad_code";

  if (msg.includes("already been registered") || msg.includes("already registered")) return "email_taken";
  if (msg.includes("signups not allowed"))                                            return "no_account";
  if (msg.includes("rate limit"))                                                     return "rate_limited";
  if (msg.includes("expired") || msg.includes("invalid"))                             return "bad_code";

  return "unknown";
};

export interface Account {
  userId: string;
  /** Confirmed address. Null while anonymous, or while a change is unconfirmed. */
  email: string | null;
  /** Address awaiting OTP confirmation, if a sign-up is mid-flight. */
  pendingEmail: string | null;
  isAnonymous: boolean;
}

/** Who the browser currently is, as far as Supabase is concerned. */
export const readAccount = async (): Promise<Account | null> => {
  try {
    const { data, error } = await createClient().auth.getUser();
    if (error || !data.user) return null;

    const u = data.user;
    return {
      userId:       u.id,
      email:        u.email ?? null,
      pendingEmail: (u.new_email as string | undefined) ?? null,
      // Supabase leaves is_anonymous true until the email is confirmed, which is
      // exactly the semantics the UI wants: not backed up until verified.
      isAnonymous:  u.is_anonymous === true,
    };
  } catch {
    return null;
  }
};

// ── Sign up: attach an email to the anonymous user we already are ───────────

/**
 * Sends a 6-digit code to `email` and stages it as the anonymous user's address.
 * The uid does not change, so the ledger needs no migration.
 *
 * Requires the "Change Email Address" template in Supabase to contain
 * {{ .Token }} — without it the user is emailed a link and never sees a code.
 */
export const requestSignupCode = async (email: string): Promise<AuthResult> => {
  if (isOffline()) return fail("offline");

  try {
    const { error } = await createClient().auth.updateUser({ email });
    if (error) return fail(classify(error));
    return { ok: true, data: undefined };
  } catch {
    return fail(isOffline() ? "offline" : "unknown");
  }
};

/**
 * Confirms the staged address. On success the user stops being anonymous and
 * keeps every row they created before signing up.
 */
export const verifySignupCode = async (email: string, token: string): Promise<AuthResult<string>> => {
  if (isOffline()) return fail("offline");

  try {
    const { data, error } = await createClient().auth.verifyOtp({
      email,
      token,
      type: "email_change",
    });
    if (error || !data.user) return fail(classify(error));

    resetSessionCache();
    return { ok: true, data: data.user.id };
  } catch {
    return fail(isOffline() ? "offline" : "unknown");
  }
};

// ── Log in: replace this device's identity with an existing account ─────────

/**
 * `shouldCreateUser: false` is load-bearing. Left at its default, an unknown
 * address silently mints a brand-new empty account and the user is told they
 * logged in successfully — while looking at none of their data.
 */
export const requestLoginCode = async (email: string): Promise<AuthResult> => {
  if (isOffline()) return fail("offline");

  try {
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) return fail(classify(error));
    return { ok: true, data: undefined };
  } catch {
    return fail(isOffline() ? "offline" : "unknown");
  }
};

/** @returns the account's uid, which the caller must adopt as a hard reset. */
export const verifyLoginCode = async (email: string, token: string): Promise<AuthResult<string>> => {
  if (isOffline()) return fail("offline");

  try {
    const { data, error } = await createClient().auth.verifyOtp({
      email,
      token,
      type: "email",
    });
    if (error || !data.user) return fail(classify(error));

    resetSessionCache();
    return { ok: true, data: data.user.id };
  } catch {
    return fail(isOffline() ? "offline" : "unknown");
  }
};

// ── Sign out ────────────────────────────────────────────────────────────────

/**
 * Ends the session. The caller is responsible for clearing the ledger cache
 * before the next session starts — a signed-out device that keeps the cache
 * would hand the previous account's expenses to whoever opens the app next.
 */
export const signOut = async (): Promise<AuthResult> => {
  try {
    const { error } = await createClient().auth.signOut();
    resetSessionCache();
    if (error) return fail(classify(error));
    return { ok: true, data: undefined };
  } catch {
    resetSessionCache();
    return fail("unknown");
  }
};
