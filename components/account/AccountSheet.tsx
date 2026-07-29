"use client";

// ─── Account: Google ──────────────────────────────────────────────────────────
//
// One provider, two intents. The difference is invisible to the user and
// everything to the data:
//
//   signup  linkIdentity() attaches Google to the anonymous user this device
//           already is. Same uid, so every existing expense carries over.
//   login   signInWithOAuth() swaps in a different identity. The uid changes,
//           so the ledger on this device belongs to someone else and is dropped.
//
// Neither is resolved here. OAuth is a full page navigation: this sheet hands
// off to Google and the app unloads. What happens to the ledger is decided on
// the way back, in useSyncedLedger's boot — which is why this component has no
// success path and no callback to fire. Only a failure to *start* lands back
// here; a failure to *finish* surfaces as a toast after the redirect.

import * as React from "react";
import { Check, Cloud, Loader2, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { GoogleMark } from "@/components/account/GoogleMark";
import { linkGoogleIdentity, startGoogleLogin } from "@/lib/ledger/account";
import { cn } from "@/lib/utils";

export type AuthMode = "signup" | "login";

interface AccountSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which flow to land on. The user can switch once inside. */
  initialMode: AuthMode;
  /** Entry count, so sign-up can state exactly what is about to be saved. */
  entryCount: number;
}

export function AccountSheet({
  open,
  onOpenChange,
  initialMode,
  entryCount,
}: AccountSheetProps) {
  const [mode, setMode] = React.useState<AuthMode>(initialMode);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Re-arm on each open so a cancelled attempt never leaks into the next one.
  React.useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setBusy(false);
    setError(null);
  }, [open, initialMode]);

  const isSignup = mode === "signup";

  /**
   * Hands off to Google. `busy` is deliberately never cleared on success — the
   * browser is already navigating away, and flipping the button back to an
   * interactive state for the last frame before unload only invites a second
   * tap that starts a competing redirect.
   */
  const handleGoogle = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    const result = isSignup
      ? await linkGoogleIdentity()
      : await startGoogleLogin();

    if (!result.ok) {
      setBusy(false);
      setError(result.message);
    }
  }, [busy, isSignup]);

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
        <div className="mb-4 flex size-11 items-center justify-center rounded-[14px] bg-primary/12 text-primary">
          {isSignup
            ? <Cloud size={20} strokeWidth={2} />
            : <LogIn size={20} strokeWidth={2} />}
        </div>

        <SheetTitle className="font-display text-[20px] leading-tight font-extrabold tracking-[-0.01em] text-foreground">
          {isSignup ? "Sign up" : "Log in"}
        </SheetTitle>

        <SheetDescription className="mt-1.5 text-[13px] leading-[1.6] text-muted-foreground">
          {isSignup ? (
            entryCount > 0
              ? <>Use your Google account so you can reach {entryCount === 1 ? "your entry" : `all ${entryCount} entries`} from any device. Nothing on this device is lost.</>
              : <>Use your Google account so your entries are reachable from any device.</>
          ) : (
            <>Log in with the Google account you signed up with. This device&apos;s current entries will be replaced by your account&apos;s.</>
          )}
        </SheetDescription>

        <Button
          type="button"
          variant="outline"
          onClick={() => void handleGoogle()}
          disabled={busy}
          className="mt-5 h-11 w-full rounded-[12px] border-border bg-background text-[14px] font-semibold"
        >
          {busy ? <Loader2 className="animate-spin" /> : <GoogleMark />}
          {busy ? "Opening Google…" : "Continue with Google"}
        </Button>

        {error && (
          <p role="alert" className="mt-2.5 text-xs leading-[1.5] text-destructive">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => { setMode(isSignup ? "login" : "signup"); setError(null); }}
          className="mt-3.5 w-full cursor-pointer text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {isSignup
            ? "Already have an account? Log in"
            : "New here? Create an account"}
        </button>

        {isSignup && (
          <p className="mt-4 flex items-start justify-center gap-1.5 text-[11px] leading-[1.5] text-muted-foreground/80">
            <Check size={12} strokeWidth={2.4} className="mt-px shrink-0 text-emerald-500" />
            Your {entryCount > 0 ? `${entryCount} ` : ""}existing entries stay exactly as they are.
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
