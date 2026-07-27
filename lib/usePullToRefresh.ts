"use client";

import { useEffect, useRef, useState } from "react";

export type PullPhase = "idle" | "pulling" | "armed" | "refreshing";

interface Options {
  /** Runs on release past the threshold. The indicator holds until it settles. */
  onRefresh: () => Promise<unknown>;
  /** Gate the gesture off while a modal owns the screen, or before hydration. */
  enabled?: boolean;
}

/** Finger travel that arms the refresh. */
const THRESHOLD = 64;
/** Hard stop on the reveal, so a long drag can't push the dashboard off-screen. */
const MAX_PULL = 96;
/** Height the indicator holds at while the refresh is in flight. */
const REST = 48;
/**
 * A sync that resolves in 80ms would otherwise flash the spinner and look like
 * nothing happened. Holding briefly makes the gesture read as completed.
 */
const MIN_SPIN = 550;

/**
 * Asymptotic resistance: the reveal approaches MAX_PULL but never reaches it,
 * so the pull keeps feeling responsive instead of hitting a dead stop.
 */
const resist = (dy: number) => MAX_PULL * (1 - Math.exp(-dy / MAX_PULL));

/** Reveal height at the arming point — used to normalise `progress` to 0..1. */
const ARM_DISTANCE = resist(THRESHOLD);

/**
 * Pull-to-refresh for the page scroller.
 *
 * Hand-rolled rather than relying on the browser's: `overscroll-behavior: none`
 * already suppresses the native gesture (it had to, or the month swiper would
 * fight it), and the native one can't report what it refreshed.
 *
 * The gesture is claimed once, at the first meaningful movement, and never
 * stolen mid-drag. Three gestures start from the same place on this screen —
 * a downward pull, a vertical scroll, and the horizontal month swipe — so the
 * decision has to be made early and held, otherwise a diagonal drag flickers
 * between two of them.
 */
export function usePullToRefresh<T extends HTMLElement>({ onRefresh, enabled = true }: Options) {
  const ref = useRef<T | null>(null);
  const [distance, setDistance] = useState(0);
  const [phase, setPhase] = useState<PullPhase>("idle");

  // Refs, not state: the listeners are registered once. Reading `enabled` or
  // `onRefresh` from state would mean tearing them down and re-attaching on
  // every render, which can drop a gesture already in progress.
  const enabledRef = useRef(enabled);
  const onRefreshRef = useRef(onRefresh);
  enabledRef.current = enabled;
  onRefreshRef.current = onRefresh;

  const startY = useRef(0);
  const startX = useRef(0);
  const tracking = useRef(false); // gesture began at the top of the page
  const engaged = useRef(false); // committed to a vertical pull
  const armed = useRef(false);
  const busy = useRef(false);

  // A modal opening (or hydration flipping) mid-pull abandons the gesture.
  // An in-flight refresh is left alone — it still has a result to report.
  useEffect(() => {
    if (enabled) return;
    tracking.current = false;
    engaged.current = false;
    armed.current = false;
    if (!busy.current) {
      setDistance(0);
      setPhase("idle");
    }
  }, [enabled]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;

    const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;

    const abandon = () => {
      tracking.current = false;
      engaged.current = false;
      armed.current = false;
      setDistance(0);
      setPhase("idle");
    };

    const onStart = (e: TouchEvent) => {
      if (busy.current || !enabledRef.current || e.touches.length !== 1 || !atTop()) {
        tracking.current = false;
        return;
      }
      tracking.current = true;
      engaged.current = false;
      startY.current = e.touches[0].clientY;
      startX.current = e.touches[0].clientX;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking.current) return;
      const dy = e.touches[0].clientY - startY.current;
      const dx = e.touches[0].clientX - startX.current;

      if (!engaged.current) {
        // Below the slop radius the direction isn't knowable yet — wait.
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        // Upward belongs to the scroller, horizontal-leaning to the month
        // swiper. Bail out of the whole gesture rather than re-checking, so a
        // drag that starts sideways can't become a pull halfway down.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop()) {
          tracking.current = false;
          return;
        }
        engaged.current = true;
      }

      // Dragged back above the origin: hand the gesture to the scroller.
      if (dy <= 0) {
        abandon();
        return;
      }

      // Suppresses the browser's own overscroll so the page doesn't rubber-band
      // behind the indicator. Only works on a non-passive listener.
      e.preventDefault();

      setDistance(resist(dy));

      const nowArmed = dy >= THRESHOLD;
      if (nowArmed !== armed.current) {
        armed.current = nowArmed;
        // Present on Android; absent on iOS Safari, hence the optional call.
        if (nowArmed) navigator.vibrate?.(8);
      }
      setPhase(nowArmed ? "armed" : "pulling");
    };

    const onEnd = () => {
      const wasEngaged = engaged.current;
      const wasArmed = armed.current;
      tracking.current = false;
      engaged.current = false;
      armed.current = false;

      if (!wasEngaged) return;
      if (!wasArmed) {
        setDistance(0);
        setPhase("idle");
        return;
      }

      busy.current = true;
      setDistance(REST);
      setPhase("refreshing");

      const started = Date.now();
      void (async () => {
        try {
          await onRefreshRef.current();
        } catch {
          // The caller owns error reporting (it already toasts). The indicator's
          // only job here is to retract rather than hang.
        }
        const left = MIN_SPIN - (Date.now() - started);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        busy.current = false;
        if (cancelled) return;
        setDistance(0);
        setPhase("idle");
      })();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });

    return () => {
      cancelled = true;
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return {
    ref,
    distance,
    phase,
    /** 0..1 up to the arming point, then clamped. Drives the arrow rotation. */
    progress: Math.min(1, distance / ARM_DISTANCE),
    /** True while the finger is down — callers disable transitions so it tracks. */
    dragging: phase === "pulling" || phase === "armed",
  };
}
