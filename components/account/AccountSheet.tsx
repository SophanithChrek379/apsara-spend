"use client";

// ─── Account: email + OTP ─────────────────────────────────────────────────────
//
// Two flows behind one sheet, because from the user's side they are the same
// gesture — "put my email in, type the code" — and only the outcome differs:
//
//   signup  attaches an email to the anonymous user this device already is.
//           Same uid, so every existing expense carries over untouched.
//   login   swaps in a different identity. The caller wipes the local ledger
//           and pulls the account's, which is why onAuthenticated reports the
//           mode: the two demand opposite handling of local data.
//
// The sheet never touches the ledger itself. It resolves an identity and hands
// the uid up; useSyncedLedger owns what that means for the data.

import * as React from "react";
import { ArrowLeft, Check, HelpCircle, Loader2, Mail, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  requestLoginCode,
  requestSignupCode,
  startGoogleLogin,
  startGoogleSignup,
  verifyLoginCode,
  verifySignupCode,
  type AuthResult,
} from "@/lib/ledger/account";
import { cn } from "@/lib/utils";

export type AuthMode = "signup" | "login";

const CODE_LENGTH = 6;

/** Matches Supabase's own default cooldown between OTP sends. */
const RESEND_COOLDOWN_S = 60;

/**
 * How long to wait on the code step before offering help, unprompted.
 *
 * A send that Supabase accepts can still die inside the mail provider — an
 * unverified sending domain, a bounce, a spam filter. That happens after the
 * API has already answered 200, so the app is never told and cannot show an
 * error. Silence is the only symptom, and a user staring at six empty boxes
 * has no way to know whether to keep waiting.
 *
 * 25s is past the point where a working email has almost always landed, and
 * still short enough to reach someone before they give up and close the sheet.
 */
const HELP_AFTER_MS = 25_000;

/** Deliberately permissive — the real check is whether the code arrives. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface AccountSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which flow to land on. The user can switch once inside. */
  initialMode: AuthMode;
  /** Entry count, so signup can state exactly what is about to be backed up. */
  entryCount: number;
  /**
   * Identity resolved. For "login" the caller MUST clear local data before
   * pulling; for "signup" it must not.
   */
  onAuthenticated: (userId: string, mode: AuthMode, email: string) => Promise<void> | void;
}

export function AccountSheet({
  open,
  onOpenChange,
  initialMode,
  entryCount,
  onAuthenticated,
}: AccountSheetProps) {
  const [mode, setMode]       = React.useState<AuthMode>(initialMode);
  const [step, setStep]       = React.useState<"email" | "code">("email");
  const [email, setEmail]     = React.useState("");
  const [code, setCode]       = React.useState("");
  const [busy, setBusy]       = React.useState(false);
  const [error, setError]     = React.useState<string | null>(null);
  const [notice, setNotice]   = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(0);
  const [showHelp, setShowHelp] = React.useState(false);
  // Bumped on every accepted send, so a resend restarts the help timer rather
  // than leaving the previous attempt's panel on screen as if nothing happened.
  const [sendCount, setSendCount] = React.useState(0);

  // Re-arm on each open so a cancelled attempt never leaks into the next one.
  React.useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setStep("email");
    setCode("");
    setBusy(false);
    setError(null);
    setNotice(null);
    setCooldown(0);
    setShowHelp(false);
    setSendCount(0);
  }, [open, initialMode]);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Arm the "didn't get it?" panel whenever we land on the code step, and
  // re-arm on each resend. Leaving the step tears the timer down with it.
  React.useEffect(() => {
    if (step !== "code") return;
    setShowHelp(false);
    const t = setTimeout(() => setShowHelp(true), HELP_AFTER_MS);
    return () => clearTimeout(t);
  }, [step, sendCount]);

  const trimmedEmail = email.trim().toLowerCase();
  const emailValid   = EMAIL_RE.test(trimmedEmail);

  /**
   * Send (or resend) the code. The cross-over cases are the interesting part:
   * signing up with a taken address and logging in to one that doesn't exist
   * are both dead ends, so each flips the sheet into the other mode with the
   * address preserved rather than making the user start over.
   */
  const sendCode = React.useCallback(async (forMode: AuthMode): Promise<boolean> => {
    setBusy(true);
    setError(null);

    const result: AuthResult = forMode === "signup"
      ? await requestSignupCode(trimmedEmail)
      : await requestLoginCode(trimmedEmail);

    setBusy(false);

    if (result.ok) {
      setCooldown(RESEND_COOLDOWN_S);
      setSendCount((n) => n + 1);
      return true;
    }

    if (result.failure === "email_taken") {
      setMode("login");
      setNotice("That email already has an account — log in to it instead.");
      setError(null);
      return false;
    }
    if (result.failure === "no_account") {
      setMode("signup");
      setNotice("No account for that email yet — this will create one.");
      setError(null);
      return false;
    }

    setError(result.message);
    return false;
  }, [trimmedEmail]);

  /**
   * Hands off to Google. There is no success branch to write: when this works
   * the browser is already leaving the page, so `busy` stays set and the sheet
   * sits inert for the moment before unload rather than flickering back to an
   * interactive state nobody gets to use.
   */
  const handleGoogle = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const result = mode === "signup"
      ? await startGoogleSignup()
      : await startGoogleLogin();

    if (!result.ok) {
      setBusy(false);
      setError(result.message);
    }
  }, [busy, mode]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailValid || busy) return;
    setNotice(null);
    if (await sendCode(mode)) {
      setCode("");
      setStep("code");
    }
  };

  const handleVerify = React.useCallback(async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);

    const result = mode === "signup"
      ? await verifySignupCode(trimmedEmail, value)
      : await verifyLoginCode(trimmedEmail, value);

    if (!result.ok) {
      setBusy(false);
      setCode("");
      setError(result.message);
      return;
    }

    // Stays busy through the parent's work: adoptAccount clears the ledger and
    // pulls, and letting the sheet close before that lands would flash an empty
    // dashboard on the way to the real one.
    await onAuthenticated(result.data, mode, trimmedEmail);
    setBusy(false);
    onOpenChange(false);
  }, [busy, mode, trimmedEmail, onAuthenticated, onOpenChange]);

  const isSignup = mode === "signup";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* z-[60] on both layers: this sheet is opened from inside the Settings
          sheet, which sits at Radix's default z-50. Equal z-index would leave
          the stacking order down to portal mount order — correct today, silently
          wrong the moment either sheet's mount timing changes.

          The scrim is lighter than the default bg-black/50 because it lands on
          top of the Settings scrim, and two at full strength stack to ~75% —
          dark enough that the panel underneath reads as broken rather than
          inert. */}
      <SheetContent
        side="bottom"
        overlayClassName="z-[60] bg-black/25"
        className={cn(
          "z-[60] mx-auto max-h-[92dvh] w-full max-w-[480px] gap-0 overflow-y-auto",
          "rounded-t-[22px] border-border bg-card px-5 pt-5 font-sans",
          "pb-[calc(env(safe-area-inset-bottom)+1.75rem)]",
          // Centred from 768px up, to match the Settings sheet this opens from —
          // a bottom-anchored panel over a centred one reads as two unrelated
          // surfaces. Centring via inset-y-0 + my-auto + h-fit, never a
          // translate: Radix animates transform on this element.
          "md:inset-y-0 md:my-auto md:h-fit md:max-h-[88dvh] md:rounded-[22px] md:border md:pb-7",
          "md:data-[state=open]:slide-in-from-bottom-4 md:data-[state=closed]:slide-out-to-bottom-4",
        )}
      >
        {step === "code" && (
          <button
            type="button"
            onClick={() => { setStep("email"); setError(null); setCode(""); }}
            className="mb-3 -ml-1 flex w-fit items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={13} strokeWidth={2.2} />
            Change email
          </button>
        )}

        <div className="mb-4 flex size-11 items-center justify-center rounded-[14px] bg-primary/12 text-primary">
          {step === "code"
            ? <ShieldCheck size={20} strokeWidth={2} />
            : <Mail size={20} strokeWidth={2} />}
        </div>

        <SheetTitle className="font-display text-[20px] leading-tight font-extrabold tracking-[-0.01em] text-foreground">
          {step === "code"
            ? "Enter your code"
            : isSignup ? "Back up your data" : "Log in"}
        </SheetTitle>

        <SheetDescription className="mt-1.5 text-[13px] leading-[1.6] text-muted-foreground">
          {step === "code" ? (
            <>We sent a {CODE_LENGTH}-digit code to <span className="font-semibold text-foreground">{trimmedEmail}</span>.</>
          ) : isSignup ? (
            entryCount > 0
              ? <>Add an email so you can reach {entryCount === 1 ? "your entry" : `all ${entryCount} entries`} from any device. Nothing on this device is lost.</>
              : <>Add an email so your entries are reachable from any device.</>
          ) : (
            <>Enter the email on your account. This device&apos;s current entries will be replaced by your account&apos;s.</>
          )}
        </SheetDescription>

        {notice && (
          <p className="mt-4 rounded-[10px] border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-xs leading-[1.55] text-foreground">
            {notice}
          </p>
        )}

        {step === "email" ? (
          <form onSubmit={handleEmailSubmit} className="mt-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleGoogle()}
              disabled={busy}
              className="h-11 w-full rounded-[12px] border-border bg-background text-[14px] font-semibold"
            >
              <GoogleMark />
              Continue with Google
            </Button>

            <div className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-medium text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <Label htmlFor="account-email" className="text-xs font-medium text-muted-foreground">
              Email address
            </Label>
            <Input
              id="account-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              aria-invalid={error ? true : undefined}
              className="mt-1.5 h-11 rounded-[11px] bg-background text-[15px]"
            />

            {error && <ErrorText>{error}</ErrorText>}

            <Button
              type="submit"
              disabled={!emailValid || busy}
              className="mt-4 h-11 w-full rounded-[12px] text-[14px] font-bold"
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {busy ? "Sending code…" : "Send code"}
            </Button>

            <button
              type="button"
              onClick={() => {
                setMode(isSignup ? "login" : "signup");
                setError(null);
                setNotice(null);
              }}
              className="mt-3.5 w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {isSignup
                ? "Already have an account? Log in"
                : "New here? Back up this device instead"}
            </button>
          </form>
        ) : (
          <div className="mt-5">
            <InputOTP
              maxLength={CODE_LENGTH}
              value={code}
              autoFocus
              disabled={busy}
              onChange={(value) => {
                setCode(value);
                setError(null);
                if (value.length === CODE_LENGTH) void handleVerify(value);
              }}
            >
              <InputOTPGroup className="w-full justify-between gap-2">
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className={cn(
                      "h-13 flex-1 rounded-[11px] border-l border-border bg-background",
                      "font-display text-[19px] font-bold text-foreground first:rounded-l-[11px] last:rounded-r-[11px]",
                    )}
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>

            {error && <ErrorText>{error}</ErrorText>}

            {busy && (
              <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                {isSignup ? "Linking your account…" : "Loading your ledger…"}
              </p>
            )}

            <button
              type="button"
              disabled={cooldown > 0 || busy}
              onClick={() => void sendCode(mode)}
              className="mt-4 w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-55"
            >
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
            </button>

            {/* The silent-failure net. Nothing here is triggered by an error,
                because there is no error to catch — it appears on a timer and
                says the three things that actually resolve a missing code. */}
            {showHelp && !busy && (
              <div className="mt-4 rounded-[10px] border border-border bg-background px-3.5 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <HelpCircle size={13} strokeWidth={2.2} className="shrink-0 text-muted-foreground" />
                  Still no code?
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-[1.55] text-muted-foreground marker:text-muted-foreground/50">
                  <li>Check your spam or junk folder — first codes often land there.</li>
                  <li>
                    Make sure <span className="font-medium text-foreground">{trimmedEmail}</span> is spelled correctly.
                  </li>
                  <li>Some mail providers take up to a minute to deliver.</li>
                </ul>
                <button
                  type="button"
                  onClick={() => { setStep("email"); setError(null); setCode(""); }}
                  className="mt-2.5 cursor-pointer text-[11px] font-semibold text-primary transition-opacity hover:opacity-80"
                >
                  Try a different email
                </button>
              </div>
            )}

            {isSignup && (
              <p className="mt-4 flex items-start justify-center gap-1.5 text-[11px] leading-[1.5] text-muted-foreground/80">
                <Check size={12} strokeWidth={2.4} className="mt-px shrink-0 text-emerald-500" />
                Your {entryCount > 0 ? `${entryCount} ` : ""}existing entries stay exactly as they are.
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Google's mark, inline because lucide dropped brand icons and the four hexes
 * are Google's, not this app's theme — they must not track the theme switcher
 * or shift in light mode. Brand assets are the one place a raw colour is
 * correct; everything else on the button is still a token.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="size-[18px]">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-2.5 text-xs leading-[1.5] text-destructive">
      {children}
    </p>
  );
}
