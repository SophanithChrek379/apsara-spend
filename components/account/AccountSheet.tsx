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
import { ArrowLeft, Check, Loader2, Mail, ShieldCheck } from "lucide-react";

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
  verifyLoginCode,
  verifySignupCode,
  type AuthResult,
} from "@/lib/ledger/account";
import { cn } from "@/lib/utils";

export type AuthMode = "signup" | "login";

const CODE_LENGTH = 6;

/** Matches Supabase's own default cooldown between OTP sends. */
const RESEND_COOLDOWN_S = 60;

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
  }, [open, initialMode]);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

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
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-[480px] gap-0 overflow-y-auto rounded-t-[22px] border-border bg-card px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+1.75rem)] font-sans"
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

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-2.5 text-xs leading-[1.5] text-destructive">
      {children}
    </p>
  );
}
