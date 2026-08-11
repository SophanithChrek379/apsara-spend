"use client";

import { forwardRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface OverlayPickerFieldProps {
  type: "date" | "time";
  value: string;
  onChange: (value: string) => void;
  display: string;
  placeholder: string;
  icon: LucideIcon;
  max?: string;
  className?: string;
  "aria-label"?: string;
}

/**
 * A native date/time input styled as a fully custom display layer sitting
 * behind a near-invisible native control — dev.to/codeclown/styling-a-native-date-input.
 * Kept because it's the only technique that gives full visual control while
 * preserving the native OS picker and mobile tap ergonomics.
 *
 * Rules that must not be broken:
 *  1. No overflow:hidden on the wrapper — it would clip the tap area on iOS.
 *  2. opacity ~0 but never literal 0 — iOS ignores a fully-invisible input.
 *  3. The native input is the last child, so it stacks on top via z-index.
 *  4. No showPicker() / click-forwarding — taps must land on the input itself.
 */
export const OverlayPickerField = forwardRef<HTMLInputElement, OverlayPickerFieldProps>(
  function OverlayPickerField(
    { type, value, onChange, display, placeholder, icon: Icon, max, className, ...aria },
    ref,
  ) {
    const [focused, setFocused] = useState(false);

    return (
      <div className={cn("relative block", className)}>
        <div
          className={cn(
            "input-field pointer-events-none flex min-h-12 select-none items-center px-4 py-3.5",
            focused && "!border-primary shadow-[0_0_0_3px_var(--accent-muted)]",
          )}
        >
          <span className="font-sans text-base leading-none text-foreground">
            {value ? display : placeholder}
          </span>
          <Icon size={16} strokeWidth={1.8} className="ml-auto shrink-0 text-muted-foreground" />
        </div>

        <input
          ref={ref}
          type={type}
          value={value}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="absolute inset-0 z-10 box-border h-full min-h-12 w-full cursor-pointer opacity-[0.01] [color-scheme:dark]"
          {...aria}
        />
      </div>
    );
  },
);
OverlayPickerField.displayName = "OverlayPickerField";
