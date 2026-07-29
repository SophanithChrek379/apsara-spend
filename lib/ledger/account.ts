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
  | "send_failed"      // Supabase accepted the request, the mailer refused it
  | "oauth_unavailable" // provider switched off, or manual linking disabled
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
  send_failed:  "We couldn't send the email. Try again in a moment, or use a different address.",
  oauth_unavailable: "Google sign-in isn't available right now. Use your email instead.",
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

  // Supabase accepted the request and the SMTP relay refused it — a bad API
  // key, an unverified sending domain, the provider's own throttle. Worth its
  // own message rather than "unknown": the user can act on it by waiting or
  // trying another address, and neither is obvious from a generic failure.
  if (code === "unexpected_failure" && msg.includes("email"))        return "send_failed";

  // Both are project configuration, not anything the visitor did wrong — so
  // the message points them at the email flow instead of asking them to retry
  // something that will fail identically every time.
  if (code === "manual_linking_disabled" || msg.includes("manual linking")) return "oauth_unavailable";
  if (code === "provider_disabled" || msg.includes("provider is not enabled")) return "oauth_unavailable";

  if (msg.includes("already been registered") || msg.includes("already registered")) return "email_taken";
  if (msg.includes("signups not allowed"))                                            return "no_account";
  if (msg.includes("rate limit"))                                                     return "rate_limited";
  if (msg.includes("error sending"))                                                  return "send_failed";
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
  /**
   * Identities attached to this uid — "email", "google", … Settings reads it to
   * decide whether to offer Connect Google, which must not appear once Google
   * is already linked: linkIdentity() would reject the duplicate, and the
   * rejection only surfaces after a pointless round trip to the consent screen.
   */
  providers: string[];
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
      providers:    (u.identities ?? []).map((i) => i.provider),
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

// ── Google (OAuth) ──────────────────────────────────────────────────────────

/**
 * OAuth is a full page navigation, not a request. The app unloads, Google takes
 * over, and what comes back is a cold boot — so nothing held in React state
 * survives to tell the returning app what it was in the middle of.
 *
 * That matters because the two flows demand opposite handling of local data and
 * the uid alone cannot separate them on the way back:
 *
 *   signup/link  keeps the anonymous uid — the cache must be KEPT
 *   login        arrives on a different uid — the cache must be DROPPED
 *   cancelled    keeps the anonymous uid — the cache must be KEPT
 *
 * A cancelled login and a completed link are indistinguishable by uid. So the
 * intent is parked in localStorage before we leave and read back on boot.
 */
const OAUTH_INTENT_KEY = "apsara_oauth_intent";

export type OAuthIntent = "signup" | "login";

/**
 * Reads the parked intent and clears it in the same breath. Clearing is
 * unconditional and deliberate: an intent left armed would re-fire on the next
 * ordinary boot, and a stale "login" wipes a cache nobody asked it to.
 */
export const takeOAuthIntent = (): OAuthIntent | null => {
  try {
    const value = localStorage.getItem(OAUTH_INTENT_KEY);
    localStorage.removeItem(OAUTH_INTENT_KEY);
    return value === "signup" || value === "login" ? value : null;
  } catch {
    return null;
  }
};

/**
 * On success this never resolves in any useful sense — the browser is already
 * navigating to Google. Only the failure path gets to run, which is why the
 * caller keeps its busy state set rather than clearing it on return.
 */
const startOAuth = async (intent: OAuthIntent): Promise<AuthResult> => {
  if (isOffline()) return fail("offline");

  try {
    localStorage.setItem(OAUTH_INTENT_KEY, intent);
  } catch {
    // Private mode. The boot then can't tell a login from a link, and falls
    // through to the conservative path that keeps local data.
  }

  try {
    const supabase = createClient();
    const options  = { redirectTo: window.location.origin };

    // linkIdentity attaches Google to the anonymous user we already are, which
    // is the same uid-preserving trick updateUser({ email }) pulls for OTP.
    const { error } = intent === "signup"
      ? await supabase.auth.linkIdentity({ provider: "google", options })
      : await supabase.auth.signInWithOAuth({ provider: "google", options });

    if (error) {
      takeOAuthIntent();
      return fail(classify(error));
    }
    return { ok: true, data: undefined };
  } catch {
    takeOAuthIntent();
    return fail(isOffline() ? "offline" : "unknown");
  }
};

/**
 * Attach Google to whoever we currently are. Same uid either way, so the ledger
 * is never touched — which is what lets Settings offer this to a signed-in user
 * without making them sign out first. Signing out to link would drop them onto
 * a fresh anonymous user, and linking THAT to a Google account already tied to
 * their real one just fails, stranding them on an empty ledger.
 */
export const linkGoogleIdentity = (): Promise<AuthResult> => startOAuth("signup");

/** Replace this device's identity with an existing Google account. */
export const startGoogleLogin = (): Promise<AuthResult> => startOAuth("login");

/**
 * Reads an error handed back on the OAuth redirect, and clears it from the URL
 * so a reload cannot replay it.
 *
 * A rejected link fails server-side during the callback, long after the button
 * that started it stopped existing — the app has unloaded and come back. So the
 * only trace is in the URL, and without reading it here the user is dropped
 * back on an unchanged screen with no idea the attempt failed.
 *
 * @returns a user-facing message, or null when there is nothing worth saying.
 */
export const takeOAuthError = (): string | null => {
  if (typeof window === "undefined") return null;

  const query = new URLSearchParams(window.location.search);
  const hash  = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const kind  = query.get("error")             ?? hash.get("error");
  const code  = query.get("error_code")        ?? hash.get("error_code");
  const desc  = query.get("error_description") ?? hash.get("error_description");

  if (!kind && !code && !desc) return null;

  window.history.replaceState({}, "", window.location.pathname);

  const text = decodeURIComponent(desc ?? "").toLowerCase();

  // Backing out at the consent screen is a decision, not a fault. Reporting it
  // would tell the user something they already know and did on purpose.
  if (kind === "access_denied" || text.includes("cancel") || text.includes("denied")) {
    return null;
  }
  if (code === "identity_already_exists" || text.includes("already")) {
    return "That Google account is already linked to a different account.";
  }
  return "Google sign-in didn't finish. Try again, or use your email.";
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
