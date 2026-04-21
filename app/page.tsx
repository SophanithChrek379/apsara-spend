"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence, PanInfo } from "framer-motion";
import {
  Settings, ChevronLeft, ChevronRight, ChevronDown, X, Trash2, Plus,
  UtensilsCrossed, Bike, Zap, Users, ShoppingBag, MoreHorizontal,
  CalendarDays, Lightbulb, Lock, Check, AlertTriangle, Circle, Pencil, Receipt,
  type LucideIcon,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Currency   = "USD" | "KHR";
type CategoryId = "food" | "transpo" | "bills" | "social" | "shop" | "misc";
// Use the official LucideIcon type so Lucide component props align exactly
type IconComp   = LucideIcon;

interface Transaction {
  id: string;
  amountUSD: number;
  category: CategoryId;
  note: string;
  date: string; // ISO local-midnight
}

interface AppData {
  schema_version: number;   // D3 — incremented when shape changes; used for migration detection
  transactions: Transaction[];
  // O1 — per-month user-set budgets: key = "YYYY-MM", value = USD amount
  monthlyBalances: Record<string, number>;
}

interface Toast {
  msg: string;
  type: "warn" | "info" | "success";
  undoFn?: () => void; // optional undo callback shown as pill in toast
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EXCHANGE_RATE  = 4000;
const MAX_AMOUNT_USD = 9_999.99;
const KHR_STEP       = 100;
const STORAGE_KEY    = "apsara_spend_v2";
const SCHEMA_VERSION = 2; // D3 — bump when AppData shape changes
const MONTHS         = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL     = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Legacy constants kept for any remaining direct references.
// All style values now use CSS vars: var(--color-text-lo) and var(--color-text-ghost).
const TEXT_TERTIARY = "#94a3b8"; // updated to 7.7:1 dark-bg contrast (K1)
const TEXT_GHOST    = "#475569"; // decorative only — intentionally below AA threshold

const CATEGORIES: { id: CategoryId; label: string; Icon: IconComp; color: string }[] = [
  { id: "food",    label: "Food",    Icon: UtensilsCrossed, color: "#fb923c" },
  { id: "transpo", label: "Transpo", Icon: Bike,            color: "#38bdf8" },
  { id: "bills",   label: "Bills",   Icon: Zap,             color: "#c084fc" },
  { id: "social",  label: "Social",  Icon: Users,           color: "#34d399" },
  { id: "shop",    label: "Shop",    Icon: ShoppingBag,     color: "#f472b6" },
  { id: "misc",    label: "Misc",    Icon: MoreHorizontal,  color: "var(--color-text-lo)" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pin2 = (v: number) => Math.round(v * 100) / 100;
const genId = () => `${Date.now()}${Math.random().toString(36).substr(2, 9)}`;

const toMonthKey = (y: number, m: number) =>
  `${y}-${String(m).padStart(2, "0")}`;

const parseMonthKey = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return { year: y, month: m };
};

const todayMonthKey = () => {
  const n = new Date();
  return toMonthKey(n.getFullYear(), n.getMonth() + 1);
};

// § C-02/M-01  Local-time date — avoids UTC offset shifting the date in UTC+7
const localDateString = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// J2 — Human-readable date label: "2026-04-09" → "09 Apr 2026"
// Uses T12:00:00 (local noon) so no DST/TZ edge case can shift to the
// wrong calendar day when constructing the Date object.
const formatDisplayDate = (dateStr: string): string => {
  if (!dateStr) return "Select date";
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const shiftMonth = (key: string, delta: number): string => {
  const { year, month } = parseMonthKey(key);
  const d = new Date(year, month - 1 + delta);
  return toMonthKey(d.getFullYear(), d.getMonth() + 1);
};

const sanitizeText = (s: string) => s.replace(/[<>"'`]/g, "").slice(0, 100);

// USD sanitiser — digits + single decimal, max 4 integer digits ($9,999 max), max 2 decimal places
// e.g. "12345" → "1234"  |  "9.999" → "9.99"  |  "1234.567" → "1234.56"
const sanitizeNum = (s: string): string => {
  // Strip non-numeric chars except decimal point
  const stripped = s.replace(/[^0-9.]/g, "");
  const m = stripped.match(/^(\d{0,4})(\.?)(\d{0,2}).*$/);
  if (!m) return "";
  let intPart = m[1].replace(/^0+(?=\d)/, ""); // strip leading zeros before non-zero digit
  return intPart + m[2] + m[3];
};

// KHR display formatter — converts raw digit string to comma-separated thousands
// e.g. "50000" → "50,000"  |  "4000000" → "4,000,000"
// The underlying rawAmount always stays as plain digits for computation.
const formatKHRDisplay = (raw: string): string => {
  if (!raw) return "";
  const n = parseInt(raw, 10);
  return isNaN(n) ? "" : n.toLocaleString("en-US");
};

// § 2  KHR sanitiser — integers only, no leading zeros
const sanitizeKHR = (s: string) => {
  const digits = s.replace(/[^0-9]/g, "");
  return digits.replace(/^0+(?=\d)/, ""); // strip leading zeros before non-zero digit
};

// § 2  Snap a KHR value to the nearest valid denomination (multiple of KHR_STEP)
// Calculation freedom: returns the raw integer for display; USD conversion uses the raw value
const snapKHR = (raw: string): string => {
  const v = parseInt(raw, 10) || 0;
  if (v <= 0) return raw;
  const snapped = Math.round(v / KHR_STEP) * KHR_STEP;
  return String(snapped);
};

// § 2  Returns true when a KHR string represents a valid denomination
const isValidKHR = (raw: string): boolean => {
  const v = parseInt(raw, 10) || 0;
  return v > 0 && v % KHR_STEP === 0;
};

// ─── Storage ──────────────────────────────────────────────────────────────────

// D3 — Schema validation with version check.
// schema_version is optional so v1 data (no version field) hydrates safely.
// Transactions array and monthlyBalances object shape are always validated.
const isValidAppData = (val: unknown): val is AppData => {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.transactions)) return false;
  if (obj.monthlyBalances !== undefined && typeof obj.monthlyBalances !== "object") return false;
  // Detect schema version mismatch (future migrations)
  if (obj.schema_version !== undefined && typeof obj.schema_version !== "number") return false;
  return true;
};

const loadData = (): { data: AppData | null; corrupted: boolean } => {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { data: null, corrupted: false };

    // Parse as unknown first so we can read storage-only fields before type narrowing
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // D3 — Integrity check: if tx_count sentinel was written, verify it matches
    // the actual transactions array length. Mismatch = partial/corrupted write.
    const storedCount = parsed.tx_count;
    const txArray     = parsed.transactions;
    if (
      typeof storedCount === "number" &&
      Array.isArray(txArray) &&
      storedCount !== txArray.length
    ) {
      return { data: null, corrupted: true };
    }

    if (!isValidAppData(parsed)) return { data: null, corrupted: true };

    return {
      data: {
        schema_version:  SCHEMA_VERSION,
        transactions:    parsed.transactions,
        monthlyBalances: (parsed.monthlyBalances as Record<string, number>) ?? {},
      },
      corrupted: false,
    };
  } catch {
    return { data: null, corrupted: true };
  }
};

const saveData = (data: AppData): boolean => {
  try {
    // D3 — Write schema_version and tx_count alongside typed data.
    // tx_count is storage-only metadata (not in AppData interface) — cast to any for serialisation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = {
      ...data,
      schema_version: SCHEMA_VERSION,
      tx_count: data.transactions.length,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};

const defaultData = (): AppData => ({ schema_version: SCHEMA_VERSION, transactions: [], monthlyBalances: {} });

// ─── CategoryIcon ─────────────────────────────────────────────────────────────

function CategoryIcon({ cat, active }: { cat: typeof CATEGORIES[number]; active?: boolean }) {
  return (
    <div style={{
      background: `${cat.color}18`, borderRadius: 10, padding: 8, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <cat.Icon
        className="icon-cat"
        color={active ? cat.color : `${cat.color}70`}
        strokeWidth={1.8}
      />
    </div>
  );
}

// ─── BudgetBar ────────────────────────────────────────────────────────────────
// O5 — now driven by the dynamic monthly balance, not hardcoded constants.
// When monthBudget is 0 (not set), renders a "Set your budget" prompt instead.

function BudgetBar({ total, monthBudget, onSetBudget, onEditBudget }: {
  total: number;
  monthBudget: number;
  onSetBudget: () => void;
  onEditBudget: () => void;
}) {
  // No budget set — show prompt
  if (monthBudget <= 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>
          No budget set for this month
        </span>
        <button
          onClick={onSetBudget}
          style={{
            background: "var(--accent-muted)", border: "1px solid var(--accent-border)",
            color: "var(--accent)", borderRadius: 8, padding: "5px 12px",
            fontSize: 12, fontWeight: 600, fontFamily: "var(--font-body)",
            cursor: "pointer",
          }}
        >
          Set budget
        </button>
      </div>
    );
  }

  const pct        = Math.min((total / monthBudget) * 100, 100);
  const pctDisplay = Math.round((total / monthBudget) * 100);
  const isOver     = total > monthBudget;
  const overAmt    = pin2(total - monthBudget);

  // B1 — 4-tier threshold system: 50% info, 80% amber, 95% orange, 100%+ red
  const tier = isOver ? 4 : pctDisplay >= 95 ? 3 : pctDisplay >= 80 ? 2 : pctDisplay >= 50 ? 1 : 0;
  const tierColor = tier >= 4 ? "#ef4444" : tier === 3 ? "#f97316" : tier === 2 ? "#f59e0b" : tier === 1 ? "#3b82f6" : "#34d399";
  const tierLabel = tier >= 4 ? `Over by $${overAmt.toFixed(2)}` : tier === 3 ? "Almost at limit" : tier === 2 ? "Nearing limit" : tier === 1 ? "Halfway there" : "On track";

  return (
    <div>
      {/* Tier label + % inline above bar — no "BUDGET" eyebrow */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: tierColor, transition: "color 0.3s", fontFamily: "var(--font-body)" }}>
          {tierLabel}
        </span>
        {total > 0 && (
          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-lo)", fontFamily: "var(--font-mono)" }}>
            {pctDisplay}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Budget progress"
        aria-valuenow={pctDisplay}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={isOver ? `Over budget by $${overAmt.toFixed(2)}` : `${pctDisplay}% used — ${tierLabel}`}
        style={{ background: "var(--color-bg-nav)", borderRadius: 999, height: 7, overflow: "hidden" }}>
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          style={{ height: "100%", background: tierColor, borderRadius: 999,
            boxShadow: tier >= 3 ? `0 0 10px ${tierColor}80` : "none",
            animation: tier >= 3 ? "budgetPulse 1.6s ease-in-out infinite" : "none",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6, alignItems: "center" }}>
        {/* F1 / A3 — edit budget: prominent CTA when over budget, subtle pencil otherwise */}
        {isOver ? (
          <button onClick={onEditBudget}
            style={{ background: "#ef444420", border: "1px solid #ef444450", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "5px 10px" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#ef4444", fontFamily: "var(--font-body)" }}>Adjust budget</span>
            <ChevronRight size={12} color="#ef4444" strokeWidth={2.5} />
          </button>
        ) : (
          <button onClick={onEditBudget}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", borderRadius: 6 }}>
            <span style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>${monthBudget.toFixed(0)}</span>
            <Pencil size={10} color="var(--color-text-lo)" strokeWidth={1.8} style={{ opacity: 0.6 }} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── useFocusTrap ─────────────────────────────────────────────────────────────
// A2 — Traps keyboard focus inside a modal element.
// Collects all focusable children, focuses the first on mount, and cycles
// Tab / Shift+Tab within the container. Restores focus to the element that
// was active before the modal opened when the trap is removed.

function useFocusTrap(containerRef: React.RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    if (!active || !containerRef.current) return;

    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const FOCUSABLE = [
      "a[href]", "button:not([disabled])", "input:not([disabled])",
      "select:not([disabled])", "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(", ");

    const getFocusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Focus first focusable element inside the modal
    const first = getFocusable()[0];
    if (first) first.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const firstEl = focusable[0];
      const lastEl  = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab — wrap to last element
        if (document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        // Tab — wrap to first element
        if (document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to the element that triggered the modal
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}

// ─── MonthPicker ──────────────────────────────────────────────────────────────

function MonthPicker({ current, onSelect, onClose }: {
  current: string; onSelect: (key: string) => void; onClose: () => void;
}) {
  const { year: curYear } = parseMonthKey(current);
  const [pickerYear, setPickerYear] = useState(curYear);
  const today = todayMonthKey();
  const atMax = pickerYear >= new Date().getFullYear();
  const pickerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(pickerRef, true);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.88)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={onClose}
    >
      <motion.div
        ref={pickerRef}
        initial={{ scale: 0.92, opacity: 0, y: 16 }} animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 16 }}
        transition={{ type: "spring", damping: 22, stiffness: 300 }}
        style={{ background: "var(--color-bg-nav)", borderRadius: 24, padding: "24px 20px", border: "1px solid var(--color-border-mid)", width: "100%", maxWidth: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button aria-label="Previous year" onClick={() => setPickerYear((y) => y - 1)}
            style={{ background: "none", border: "none", borderRadius: 10, padding: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
          </button>
          <span style={{ fontSize: 20, fontWeight: 600, color: "var(--color-text-hi)", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)" }}>{pickerYear}</span>
          <button aria-label="Next year" onClick={() => setPickerYear((y) => y + 1)} disabled={atMax}
            style={{
              background: "none", border: "none", borderRadius: 10, padding: 10,
              cursor: atMax ? "default" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              opacity: atMax ? 0.3 : 1, transition: "opacity 0.2s",
            }}>
            <ChevronRight className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {MONTHS.map((m, i) => {
            const key = toMonthKey(pickerYear, i + 1);
            const isSelected = key === current, isToday = key === today, isFuture = key > today;
            return (
              <button key={m} disabled={isFuture} onClick={() => { onSelect(key); onClose(); }}
                style={{
                  padding: "11px 4px", borderRadius: 12, position: "relative",
                  border: isSelected ? "2px solid var(--accent)" : "1px solid transparent",
                  background: isSelected ? "var(--accent-muted)" : isToday ? "var(--color-border)" : "transparent",
                  color: isSelected ? "var(--accent)" : "var(--color-text-mid)",
                  opacity: isFuture ? 0.3 : 1,
                  fontFamily: "var(--font-body)",
                  fontWeight: isSelected ? 600 : 400, fontSize: 13,
                  cursor: isFuture ? "default" : "pointer",
                  transition: "all 0.15s",
                }}>
                {m}
                {isToday && !isSelected && (
                  <span style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" }} />
                )}
              </button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Responsive modal animation helper ────────────────────────────────────────
// Bottom-sheet on mobile (y: "100%"), centred scale-in on tablet+ (scale: 0.96)
const getModalAnim = () => {
  if (typeof window === "undefined") return "sheet";
  return window.innerWidth >= 768 ? "center" : "sheet";
};
const MODAL_ENTER_SHEET  = { y: "100%" };
const MODAL_ENTER_CENTER = { opacity: 0, scale: 0.96, y: 12 };
const MODAL_ANIM_SHEET   = { y: 0 };
const MODAL_ANIM_CENTER  = { opacity: 1, scale: 1, y: 0 };
const MODAL_EXIT_SHEET   = { y: "100%" };
const MODAL_EXIT_CENTER  = { opacity: 0, scale: 0.96, y: 8 };

// ─── EntryModal ───────────────────────────────────────────────────────────────

function EntryModal({ tx, selectedMonth, monthBalance, totalUSD: currentTotal, constraintMode, onSave, onDelete, onRequestDelete, onClose }: {
  tx: Transaction | null; selectedMonth: string;
  monthBalance: number;
  totalUSD: number;
  constraintMode: "soft" | "hard"; // C1 — controls whether over-budget is blocked or warned
  onSave: (t: Transaction) => void; onDelete?: (id: string) => void; onRequestDelete?: (tx: Transaction) => void; onClose: () => void;
}) {
  const isEdit = !!tx;

  // K1 FIX — localDateString(new Date(tx.date)) reads the local calendar date.
  // tx?.date.slice(0,10) read the UTC ISO string: in Cambodia (UTC+7), a
  // transaction saved at local midnight "2026-04-09T00:00:00" is stored as
  // "2026-04-08T17:00:00.000Z", so slice gave "2026-04-08" — one day behind.
  const defaultDate = tx ? localDateString(new Date(tx.date)) : (() => {
    const { year: ym, month: mm } = parseMonthKey(selectedMonth);
    const todayLocal  = localDateString();
    const todayPrefix = `${String(ym)}-${String(mm).padStart(2, "0")}`;
    return todayLocal.startsWith(todayPrefix) ? todayLocal : `${todayPrefix}-01`;
  })();

  const [currency,      setCurrency]      = useState<Currency>("USD");
  const [rawAmount,     setRawAmount]     = useState(tx ? String(tx.amountUSD) : "");
  const [cat,           setCat]           = useState<CategoryId>(tx?.category ?? "food");
  const [note,          setNote]          = useState(tx?.note ?? "");
  const [date,          setDate]          = useState(defaultDate);
  const [shake,         setShake]         = useState(false);
  const [amtFocused,    setAmtFocused]    = useState(false);
  const [dateFocused,   setDateFocused]   = useState(false);
  // § 2  KHR denomination hint state — shown when amount is not a multiple of KHR_STEP
  const [khrHint,       setKhrHint]       = useState(false);
  const amountRef    = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const modalRef     = useRef<HTMLDivElement>(null);

  // Cursor-to-end on manual focus (edit mode — pre-filled value)
  const handleAmountFocus = () => {
    setAmtFocused(true);
    const el = amountRef.current;
    if (!el) return;
    const len = el.value.length;
    el.setSelectionRange(len, len);
  };
  useFocusTrap(modalRef, true);

  // Currency switch: convert the current amount to the new currency so the user
  // always sees the correct equivalent value without re-typing.
  // USD→KHR: 50 → 200,000 (×4,000, snapped to nearest 100 KHR step)
  // KHR→USD: 200,000 → 50 (÷4,000, rounded to 2 dp)
  // If the field is empty, just switch the label — nothing to convert.
  const handleCurrencyChange = (c: Currency) => {
    if (c === currency) return;

    if (rawAmount) {
      if (currency === "USD" && c === "KHR") {
        const usdVal = parseFloat(rawAmount) || 0;
        const khrRaw = Math.round(usdVal * EXCHANGE_RATE / KHR_STEP) * KHR_STEP;
        setRawAmount(khrRaw > 0 ? String(khrRaw) : "");
      } else if (currency === "KHR" && c === "USD") {
        const khrVal = parseInt(rawAmount, 10) || 0;
        const usdVal = pin2(khrVal / EXCHANGE_RATE);
        setRawAmount(usdVal > 0 ? String(usdVal) : "");
      }
    }

    setCurrency(c);
    setKhrHint(false);
  };

  // § 2  Snap KHR to nearest multiple of KHR_STEP on blur — prevents "impossible" denominations
  const handleAmountBlur = () => {
    if (currency === "KHR" && rawAmount) {
      const snapped = snapKHR(rawAmount);
      setRawAmount(snapped);
      setKhrHint(false);
    }
  };

  // § 2  Show denomination hint while user is typing an invalid KHR amount.
  // Strip commas first — they appear in the display value (e.g. "50,000")
  // but must not be passed to parseInt for the raw stored value.
  const handleKHRChange = (val: string) => {
    // Max 8 raw digits: 9,999.99 USD × 4,000 = 39,999,960 KHR = 8 digits
    const digits = val.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "").slice(0, 8);
    setRawAmount(digits);
    const v = parseInt(digits, 10) || 0;
    setKhrHint(v > 0 && v % KHR_STEP !== 0);
  };

  const toUSD = (raw: string): number => {
    const v = currency === "KHR" ? parseInt(raw, 10) || 0 : parseFloat(raw) || 0;
    return currency === "KHR" ? pin2(v / EXCHANGE_RATE) : pin2(v);
  };

  // C1 — showHardConfirm: true when hard mode needs user confirmation before saving over budget
  const [showHardConfirm, setShowHardConfirm] = useState(false);

  const commitSave = () => {
    // Shared save logic — called directly in soft mode, after confirmation in hard mode
    const catLabel = CATEGORIES.find((c) => c.id === cat)!.label;
    onSave({
      id:        tx?.id ?? genId(),
      amountUSD: toUSD(rawAmount),
      category:  cat,
      note:      sanitizeText(note) || catLabel,
      date:      new Date(`${date}T00:00:00`).toISOString(),
    });
    onClose();
  };

  const handleSave = () => {
    // KHR denomination guard
    if (currency === "KHR" && !isValidKHR(rawAmount)) {
      setShake(true); setKhrHint(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    const usd = toUSD(rawAmount);
    if (!usd || usd <= 0 || usd > MAX_AMOUNT_USD) {
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    if (wouldExceed) {
      if (constraintMode === "hard") {
        // C3 — Hard mode: show confirmation modal before allowing over-budget save
        setShowHardConfirm(true);
        return;
      }
      // C2 — Soft mode: allow save, UI turns red — no block
    }
    commitSave();
  };

  const parsedAmt  = currency === "KHR" ? parseInt(rawAmount, 10) || 0 : parseFloat(rawAmount) || 0;
  const previewUSD = toUSD(rawAmount);
  const borderColor = shake ? "#ef4444" : khrHint ? "#f59e0b" : amtFocused ? "var(--accent)" : parsedAmt > 0 ? "var(--accent-border)" : "var(--color-border)";
  const amtBoxShadow = amtFocused && !shake && !khrHint ? "0 0 0 3px var(--accent-muted)" : "none";

  // Adaptive font size — shrinks as the display value gets longer to prevent overflow
  const displayVal = currency === "KHR" ? formatKHRDisplay(rawAmount) : rawAmount;
  const amountFontSize = displayVal.length <= 7 ? 32 : displayVal.length <= 10 ? 26 : 22;

  // P1 — Over-limit guard: only active when a budget is set and this is a new entry.
  // For edits we skip the check (editing can only reduce spend or stay neutral).
  const wouldExceed = !tx && monthBalance > 0 && previewUSD > 0
    && pin2(currentTotal + previewUSD) > monthBalance;

  const modalMode = getModalAnim();
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="modal-backdrop"
      style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.9)", zIndex: 200, display: "flex" }}
      onClick={onClose}
    >
      <motion.div
        ref={modalRef}
        initial={modalMode === "center" ? MODAL_ENTER_CENTER : MODAL_ENTER_SHEET}
        animate={modalMode === "center" ? MODAL_ANIM_CENTER  : MODAL_ANIM_SHEET}
        exit={modalMode   === "center" ? MODAL_EXIT_CENTER   : MODAL_EXIT_SHEET}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        className="modal-sheet"
        style={{ background: "var(--color-bg-card)", padding: "28px 24px 44px", width: "100%", border: "1px solid var(--color-border-mid)", maxWidth: 480, margin: "0 auto", position: "relative" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle — only on mobile bottom-sheet */}
        {modalMode === "sheet" && <div style={{ width: 40, height: 4, background: "var(--color-border-mid)", borderRadius: 2, margin: "0 auto 24px" }} />}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 22, fontWeight: 600, color: "var(--color-text-hi)", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)", lineHeight: 1.2 }}>
            {isEdit ? "Edit Expense" : "New Expense"}
          </span>
          <button aria-label="Close" onClick={onClose}
            style={{ background: "var(--color-bg-nav)", border: "none", borderRadius: 9, padding: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, minHeight: 36 }}>
            <X className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
          </button>
        </div>

        {/* Currency toggle */}
        <div style={{ display: "flex", background: "var(--color-bg-nav)", borderRadius: 12, padding: 4, marginBottom: 16, gap: 4 }}>
          {(["USD", "KHR"] as Currency[]).map((c) => (
            <button key={c} onClick={() => handleCurrencyChange(c)}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 9, border: "none", cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontWeight: 600, fontSize: 14, letterSpacing: "0.04em", transition: "all 0.18s",
                background: currency === c ? "var(--accent)" : "transparent",
                color:      currency === c ? "#0d0f14" : "var(--color-text-lo)",
              }}>
              {c === "USD" ? "$ USD" : "៛ KHR"}
            </button>
          ))}
        </div>

        {/* Amount input */}
        <motion.div
          animate={shake ? { x: [0, -7, 7, -5, 5, 0] } : { x: 0 }}
          transition={{ duration: 0.35 }}
          style={{ position: "relative", marginBottom: 8 }}
        >
          {/* Currency symbol */}
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 22, color: "var(--accent)", fontWeight: 700, fontFamily: "var(--font-headline)", pointerEvents: "none", zIndex: 1 }}>
            {currency === "USD" ? "$" : "៛"}
          </span>

          <input
            ref={amountRef}
            type="text"
            inputMode={currency === "KHR" ? "numeric" : "decimal"}
            autoFocus
            value={currency === "KHR" ? formatKHRDisplay(rawAmount) : rawAmount}
            onChange={(e) =>
              currency === "KHR"
                ? handleKHRChange(e.target.value)
                : setRawAmount(sanitizeNum(e.target.value))
            }
            onFocus={handleAmountFocus}
            onBlur={() => { setAmtFocused(false); handleAmountBlur(); }}
            onWheel={(e) => e.currentTarget.blur()}
            placeholder={currency === "USD" ? "0.00" : "0"}
            className="input-field focus-input"
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "14px 44px 14px 50px",
              fontSize: amountFontSize, fontWeight: 800, fontFamily: "var(--font-mono)",
              border: `1.5px solid ${borderColor}`,
              boxShadow: amtBoxShadow,
              transition: "border-color 0.18s, box-shadow 0.18s, font-size 0.12s ease",
            }}
          />

          {/* Clear button — visible when a value has been entered */}
          {rawAmount && (
            <button
              type="button"
              aria-label="Clear amount"
              onClick={() => { setRawAmount(""); setKhrHint(false); amountRef.current?.focus(); }}
              style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                background: "var(--color-bg-nav)", border: "none", borderRadius: 6, padding: 5,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 2, minWidth: 28, minHeight: 28,
              }}
            >
              <X size={14} color="var(--color-text-lo)" strokeWidth={2.5} />
            </button>
          )}
        </motion.div>

        {/* KHR preview — moved below input so it never overlaps the number */}
        {currency === "KHR" && parsedAmt > 0 && (
          <div style={{ fontSize: 12, color: "#34d399", fontWeight: 600, fontFamily: "var(--font-body)", marginBottom: khrHint ? 4 : 16, paddingLeft: 4, lineHeight: 1 }}>
            ≈ ${previewUSD.toFixed(2)}
          </div>
        )}

        {/* § 2  KHR denomination hint — shown live when user types a non-multiple of 100 */}
        {khrHint && (
          <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 16, paddingLeft: 4, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
            KHR must be a multiple of {KHR_STEP} (e.g. 100, 500, 1,000 ៛). Tap outside to auto-correct.
          </div>
        )}

        {/* P4 — Over-limit warning banner — shown live as user types */}
        {wouldExceed && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}
            style={{
              background: "#f59e0b15", border: "1px solid #f59e0b40",
              borderRadius: 10, padding: "10px 14px", marginBottom: 16,
              display: "flex", alignItems: "flex-start", gap: 10,
            }}
          >
            <AlertTriangle size={14} color="var(--accent)" strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12, color: "#fcd34d", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
              This entry exceeds your{" "}
              <span style={{ fontWeight: 700 }}>${monthBalance.toFixed(0)}</span> budget by{" "}
              <span style={{ fontWeight: 700 }}>
                ${pin2(currentTotal + previewUSD - monthBalance).toFixed(2)}
              </span>.
              Let's maintain your financial goals.
            </span>
          </motion.div>
        )}

        {/* Note */}
        <input
          type="text" value={note}
          onChange={(e) => setNote(sanitizeText(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          onFocus={(e) => { const len = e.target.value.length; e.target.setSelectionRange(len, len); }}
          placeholder="Note (optional, max 100 chars)..."
          maxLength={100}
          className="input-field"
          style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", fontSize: 16, fontFamily: "var(--font-body)", lineHeight: 1.5, marginBottom: 16 }}
        />

        {/* ── Date picker — article technique: full-area transparent overlay ──
            Source: dev.to/codeclown/styling-a-native-date-input…
            Key rules from the article:
            1. NO overflow:hidden on wrapper (clips tap area on iOS)
            2. opacity: 0.01 not 0  (iOS ignores truly invisible elements)
            3. input is LAST child so it stacks on top naturally (z-index:1)
            4. No showPicker() / button click — taps go directly to the input
            5. Display div has pointerEvents:none so taps pass through
            ─────────────────────────────────────────────────────────────── */}
        <div style={{ position: "relative", marginBottom: 16, display: "block" }}>

          {/* ── Display layer (behind, pointer-events:none) ── */}
          <div
            className="input-field"
            style={{
              display: "flex", alignItems: "center",
              borderRadius: 12,
              padding: "14px 16px",
              minHeight: 48,
              pointerEvents: "none",
              userSelect: "none",
              transition: "border 0.18s, box-shadow 0.18s",
              ...(dateFocused ? {
                border: "1.5px solid var(--accent)",
                boxShadow: "0 0 0 3px var(--accent-muted)",
              } : {
                border: "1.5px solid var(--color-border)",
              }),
            }}
          >
            <span style={{
              fontSize: 16,
              fontFamily: "var(--font-body)",
              lineHeight: 1,
              color: "var(--color-text-hi)",
            }}>
              {date ? formatDisplayDate(date) : "Select date"}
            </span>
            <CalendarDays
              size={16}
              color="var(--color-text-lo)"
              strokeWidth={1.8}
              style={{ marginLeft: "auto", flexShrink: 0 }}
            />
          </div>

          {/* ── Native input overlay (on top, full parent coverage) ──
              inset:0 + width:100% + height:100% — anchors to all four edges
              of the position:relative wrapper, covering the entire display
              div so any tap anywhere inside the block opens the date picker.
              opacity:0.01 — visually invisible, iOS still treats as interactive
              z-index:1 — topmost tap target in the stacking context
              minHeight:48px — prevents collapse if wrapper has no height yet  */}
          <input
            ref={dateInputRef}
            type="date"
            value={date}
            max={localDateString()}
            onChange={(e) => setDate(e.target.value)}
            onFocus={() => setDateFocused(true)}
            onBlur={() => setDateFocused(false)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              minHeight: 48,
              opacity: 0.01,
              zIndex: 1,
              cursor: "pointer",
              colorScheme: "dark",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Category picker — horizontal 1×6 row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 16 }}>
          {CATEGORIES.map((c) => {
            const active = cat === c.id;
            return (
              <button key={c.id} onClick={() => setCat(c.id)} aria-label={c.label} title={c.label}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "10px 2px 8px", borderRadius: 12, gap: 4,
                  border:     active ? `2px solid ${c.color}` : "1.5px solid var(--color-border)",
                  background: active ? `${c.color}18` : "var(--color-bg-input)",
                  cursor: "pointer", transition: "all 0.15s", minHeight: 60,
                }}>
                <c.Icon className="icon-cat" color={active ? c.color : "var(--color-text-lo)"} strokeWidth={1.8} />
                <span style={{ fontSize: 10, color: active ? c.color : "var(--color-text-lo)", fontWeight: active ? 600 : 400, fontFamily: "var(--font-body)" }}>
                  {c.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Primary action */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSave}
            disabled={parsedAmt <= 0}
            className="btn-primary"
            style={{
              flex: 1, padding: 14,
              ...(parsedAmt <= 0 ? {
                background: "var(--color-bg-nav)",
                color: "var(--color-text-lo)",
                border: "1px solid var(--color-border-mid)",
                opacity: 0.55,
                cursor: "not-allowed",
              } : wouldExceed && constraintMode === "soft" ? {
                background: "linear-gradient(135deg, #ef4444, #dc2626)",
              } : wouldExceed && constraintMode === "hard" ? {
                background: "transparent",
                border: "1.5px solid #f59e0b60",
                color: "#f59e0b",
              } : {}),
              fontSize: 16, fontFamily: "var(--font-body)",
              boxShadow: parsedAmt <= 0 || wouldExceed ? "none" : "0 3px 16px var(--accent-glow)",
              transition: "all 0.2s",
            }}>
            {parsedAmt <= 0
              ? (isEdit ? "Save Changes" : "Add Expense")
              : wouldExceed && constraintMode === "hard"
              ? "Over budget — confirm?"
              : isEdit ? "Save Changes" : "Add Expense"}
          </button>
        </div>

        {/* Delete — separated by hairline, routes to confirm sheet */}
        {isEdit && (
          <>
            <div style={{ height: "0.5px", background: "var(--color-border)", margin: "16px 0 0" }} />
            <button
              onClick={() => { onClose(); onRequestDelete?.(tx!); }}
              aria-label="Delete this expense"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 6, width: "100%",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 500,
                color: "var(--color-text-lo)",
                fontFamily: "var(--font-body)",
                padding: "14px 0 4px",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-text-lo)"; }}
            >
              <Trash2 size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
              Delete expense
            </button>
          </>
        )}
      </motion.div>

      {/* C3 — Hard mode: over-budget confirmation overlay */}
      <AnimatePresence>
        {showHardConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.92)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
            onClick={() => setShowHardConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 8 }}
              transition={{ type: "spring", damping: 22, stiffness: 300 }}
              role="alertdialog" aria-modal="true" aria-label="Over budget confirmation"
              style={{ background: "var(--color-bg-card)", borderRadius: 24, padding: 28, width: "100%", maxWidth: 360, border: "1px solid #ef444440" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#ef444418", border: "1px solid #ef444440", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <AlertTriangle size={22} color="#ef4444" strokeWidth={2} />
              </div>
              <div style={{ textAlign: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", marginBottom: 8 }}>Over Budget</div>
                <div style={{ fontSize: 13, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.6 }}>
                  This will put you{" "}
                  <span style={{ color: "#ef4444", fontWeight: 600 }}>
                    ${pin2(currentTotal + toUSD(rawAmount) - monthBalance).toFixed(2)} over
                  </span>{" "}
                  your ${monthBalance.toFixed(0)} budget. Add anyway?
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
                <button onClick={() => setShowHardConfirm(false)} className="btn-ghost"
                  style={{ flex: 1, padding: "12px 0", fontSize: 14, fontFamily: "var(--font-body)" }}>
                  Cancel
                </button>
                <button onClick={() => { setShowHardConfirm(false); commitSave(); }}
                  style={{ flex: 1, padding: "12px 0", borderRadius: 14, border: "none", background: "#ef4444", color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: "var(--font-body)", cursor: "pointer" }}>
                  Add anyway
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function ApsaraSpendPage() {
  const [isLoaded,         setIsLoaded]         = useState(false);
  // K3 — Splash is shown until isLoaded fires + 400ms grace period.
  // Covers localStorage hydration so user never sees an empty/default-state flash.
  const [showSplash,       setShowSplash]       = useState(true);
  // GN1 — First-run onboarding: 3-step tooltip overlay shown once after first budget is set
  const [showOnboarding,   setShowOnboarding]   = useState(false);
  const [onboardStep,      setOnboardStep]      = useState(0);
  // GN2 — Compute modal mode once; update only on window resize (not every render)
  const pageModalMode = useMemo(() => {
    if (typeof window === "undefined") return "sheet" as const;
    return window.innerWidth >= 768 ? "center" as const : "sheet" as const;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [data, setData] = useState<AppData>(() => {
    try {
      const result = loadData();
      return result.data ?? defaultData();
    } catch {
      return defaultData();
    }
  });
  const [storageCorrupted, setStorageCorrupted] = useState(false);
  const [selectedMonth,    setSelectedMonth]    = useState(todayMonthKey());
  const [swipeDir,         setSwipeDir]         = useState<1 | -1>(1);
  const [showPicker,       setShowPicker]       = useState(false);
  const [showModal,        setShowModal]        = useState(false);
  const [editTx,           setEditTx]           = useState<Transaction | null>(null);
  const [currency,         setCurrency]         = useState<Currency>("USD");
  const [showSettings,     setShowSettings]     = useState(false);
  const [resetConfirm,     setResetConfirm]     = useState(false);
  const [toast,            setToast]            = useState<Toast | null>(null);
  // L1 — category filter for the Entries list; resets whenever the month changes
  const [filterCategory,   setFilterCategory]   = useState<CategoryId | "all">("all");
  const [showFilterMenu,   setShowFilterMenu]   = useState(false);
  // L — Swipe-to-delete: openSwipeId tracks which row is snapped open.
  // confirmDeleteTx holds the transaction pending confirmation.
  const [openSwipeId,      setOpenSwipeId]      = useState<string | null>(null);
  const [confirmDeleteTx,  setConfirmDeleteTx]  = useState<Transaction | null>(null);
  const dragStarted = useRef(false);
  // MN2 — swipe hint: only show on first session, hide after first successful swipe
  const [showSwipeHint,    setShowSwipeHint]    = useState(
    () => typeof window !== "undefined" ? !localStorage.getItem("apsara_seen_swipe_hint") : true
  );
  // TX1 — Row swipe affordance: auto-peek on first session so user discovers the action
  const [hasSeenRowSwipe,  setHasSeenRowSwipe]  = useState(
    () => typeof window !== "undefined" ? !!localStorage.getItem("apsara_seen_row_swipe") : false
  );
  // I1 — Infinite scroll: show 10 rows at a time, load more as user scrolls
  const [visibleCount,     setVisibleCount]     = useState(10);
  // Fix: use callback ref instead of useRef so the observer attaches the moment
  // the sentinel div mounts (after list renders), not on initial component mount
  // when the div doesn't exist yet.
  const loadMoreRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        setVisibleCount((v) => v + 10);
      }
    }, { rootMargin: "100px", threshold: 0 });
    observer.observe(node);
    // Return cleanup via a WeakMap pattern isn't possible here, but the
    // observer auto-disconnects when the node is removed from DOM.
  }, []);
  // O2 — monthly budget flow state
  const [showBudgetModal,  setShowBudgetModal]  = useState(false);
  const [budgetInput,      setBudgetInput]      = useState("");
  const [budgetShake,      setBudgetShake]      = useState(false); // MO4
  // A2 — focus trap refs
  const budgetModalRef   = useRef<HTMLDivElement>(null);
  const budgetInputRef   = useRef<HTMLInputElement>(null);
  const settingsModalRef = useRef<HTMLDivElement>(null);

  // A2 — activate focus trap whenever these modals are open
  useFocusTrap(budgetModalRef,   showBudgetModal);

  useFocusTrap(settingsModalRef, showSettings);
  // Q3 — theme mode: system (default) | dark | light
  const [themeMode,        setThemeMode]        = useState<"dark"|"light"|"system">("system");
  // Q4 — colour palette: yellow (default) | indigo | emerald | rose
  const [palette,          setPalette]          = useState<"yellow"|"indigo"|"emerald"|"rose">("yellow");
  // C1 — constraint mode: soft (allow over-budget) | hard (confirm modal)
  const [constraintMode,   setConstraintMode]   = useState<"soft"|"hard">("soft");
  // E1 — notification permission: "default" | "granted" | "denied" | "unsupported"
  const [notifPermission,  setNotifPermission]  = useState<"default"|"granted"|"denied"|"unsupported">("default");

  const showToast = useCallback((msg: string, type: Toast["type"] = "info", undoFn?: () => void) => {
    const duration = undoFn ? 5000 : 3500;
    setToast({ msg, type, undoFn });
    setTimeout(() => setToast(null), duration);
  }, []);

  useEffect(() => {
    const { data: saved, corrupted } = loadData();
    if (corrupted) setStorageCorrupted(true);
    else if (saved) setData(saved);
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    if (storageCorrupted) showToast("Previous data could not be loaded — storage was corrupted.", "warn");
  }, [storageCorrupted, showToast]);

  // K2 — Auto-dismiss splash: 200ms after data is loaded (was 400ms — SP1 fix).
  // 200ms is enough for the exit animation to start cleanly; faster on cached loads.
  useEffect(() => {
    if (!isLoaded) return;
    const t = setTimeout(() => {
      setShowSplash(false);
      // GN1 — Show onboarding right after splash on first-ever open
      if (typeof window !== "undefined" && !localStorage.getItem("apsara_onboarded_v2")) {
        setTimeout(() => { setOnboardStep(0); setShowOnboarding(true); }, 400);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [isLoaded]);

  // SP2 — Hard 3s safety timeout: forces splash away even if localStorage read hangs.
  // Prevents the splash from showing forever on corrupted storage or slow devices.
  useEffect(() => {
    const hard = setTimeout(() => setShowSplash(false), 3000);
    return () => clearTimeout(hard);
  }, []);

  // D1 — Debounced localStorage write: state updates are instant (React),
  // but disk writes are batched every 300ms to prevent write-storm on rapid
  // entries. "Add Expense" feels instantaneous — the UI updates on the same
  // frame, the persistence happens 300ms later in the background.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isLoaded) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const ok = saveData(data);
      if (!ok) showToast("Storage quota exceeded — data may not be saved.", "warn");
    }, 300);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [data, isLoaded, showToast]);

  // Q3/T3 — Apply theme mode to <html data-theme="...">
  // System mode watches prefers-color-scheme and updates live.
  // typeof window guard prevents SSR crash on server render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const html = document.documentElement;
    const apply = (mode: "dark" | "light") => html.setAttribute("data-theme", mode);
    if (themeMode === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      apply(mq.matches ? "light" : "dark");
      const handler = (e: MediaQueryListEvent) => apply(e.matches ? "light" : "dark");
      mq.addEventListener("change", handler);
      localStorage.setItem("apsara_theme", "system");
      return () => mq.removeEventListener("change", handler);
    }
    apply(themeMode);
    localStorage.setItem("apsara_theme", themeMode);
  }, [themeMode]);

  // Q4 — Apply palette class to <html>
  useEffect(() => {
    const html = document.documentElement;
    html.className = html.className
      .split(" ")
      .filter((c) => !c.startsWith("palette-"))
      .join(" ");
    html.classList.add(`palette-${palette}`);
    localStorage.setItem("apsara_palette", palette);
  }, [palette]);

  // C1 — Persist constraintMode
  useEffect(() => { localStorage.setItem("apsara_constraint", constraintMode); }, [constraintMode]);

  // Q3/Q4/C1 — Restore all persisted preferences on first load
  useEffect(() => {
    const savedTheme      = localStorage.getItem("apsara_theme")      as "dark"|"light"|"system"|null;
    const savedPalette    = localStorage.getItem("apsara_palette")    as "yellow"|"indigo"|"emerald"|"rose"|null;
    const savedConstraint = localStorage.getItem("apsara_constraint") as "soft"|"hard"|null;
    if (savedTheme)      setThemeMode(savedTheme);
    if (savedPalette)    setPalette(savedPalette);
    if (savedConstraint) setConstraintMode(savedConstraint);
    // E1 — Read current notification permission from browser (no need to persist — browser owns it)
    if (typeof window !== "undefined") {
      if (!("Notification" in window)) {
        setNotifPermission("unsupported");
      } else {
        setNotifPermission(Notification.permission as "default"|"granted"|"denied");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // E1 — Request notification permission from the browser
  const requestNotifPermission = async () => {
    if (!("Notification" in window)) {
      setNotifPermission("unsupported");
      showToast("Your browser doesn't support notifications.", "info");
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result as "default"|"granted"|"denied");
      if (result === "granted") {
        showToast("Budget alerts enabled.", "success");
        // E2 — Test notification so user knows it works
        new Notification("Apsara Spend", {
          body: "Budget alerts are now active. You'll be notified at 80% and 95%.",
          icon: "/icon-192.png",
        });
      } else {
        showToast("Notifications blocked.", "warn");
      }
    } catch {
      showToast("Permission request failed.", "warn");
    }
  };

  // R1 / S2 — Body scroll lock: prevent background scroll while any modal is open,
  // and also while the non-scrolling init screen is active (spec §1 & §5).
  // Note: use inline balance check to avoid hoisting conflict with isBalanceLocked.
  useEffect(() => {
    const anyOpen = showModal || showSettings || showPicker || showBudgetModal;
    const nobudget = !(selectedMonth in data.monthlyBalances && data.monthlyBalances[selectedMonth] > 0);
    const initActive = isLoaded && nobudget;
    document.body.style.overflow = (anyOpen || initActive) ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [showModal, showSettings, showPicker, showBudgetModal, isLoaded, selectedMonth, data.monthlyBalances]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  // E2: useMemo — these are the most expensive derivations in the component.
  // Without memoisation they rerun on every render: modal opens, currency
  // toggles, toast appearances, and swipe animations all trigger unnecessary
  // re-sorts and re-reduces on the full transaction array.

  const monthTxs = useMemo(() =>
    data.transactions.filter((t) => {
      const d = new Date(t.date);
      return toMonthKey(d.getFullYear(), d.getMonth() + 1) === selectedMonth;
    }),
    [data.transactions, selectedMonth]
  );

  const totalUSD = useMemo(() =>
    pin2(monthTxs.reduce((s, t) => s + t.amountUSD, 0)),
    [monthTxs]
  );

  const categoryTotals = useMemo(() =>
    CATEGORIES.map((c) => {
      const txs = monthTxs.filter((t) => t.category === c.id);
      return {
        ...c,
        total: pin2(txs.reduce((s, t) => s + t.amountUSD, 0)),
        count: txs.length,
      };
    }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    [monthTxs]
  );

  const fmt = useCallback(
    (usd: number) =>
      currency === "KHR"
        ? `${Math.round(usd * EXCHANGE_RATE).toLocaleString()} ៛`
        : `$${usd.toFixed(2)}`,
    [currency]
  );

  const { year, month } = parseMonthKey(selectedMonth);
  const isCurrentMonth  = selectedMonth === todayMonthKey();
  const hasData         = monthTxs.length > 0;
  const hasBreakdown    = categoryTotals.some((c) => c.total > 0);

  // P1 — Spending guardrail derived values
  // monthBalance: the locked budget for this month (0 = not set)
  // fabDisabled: true when a budget is set AND current total has already hit or exceeded it.
  //   Note: we block on total >= balance (not total + newEntry) so the FAB
  //   responds to real spend, not speculative input (which we gate inside the modal).
  const monthBalance    = data.monthlyBalances[selectedMonth] ?? 0;
  const fabDisabled     = monthBalance > 0 && totalUSD >= monthBalance;

  // B2 / E2 — Fire toast + browser notification once per tier crossing per month.
  // firedTiers is persisted to localStorage keyed by month so it survives page reloads.
  const firedTiersKey = `apsara_fired_tiers_${selectedMonth}`;
  const getFiredTiers = () => {
    try {
      const raw = localStorage.getItem(firedTiersKey);
      return new Set<number>(raw ? JSON.parse(raw) : []);
    } catch { return new Set<number>(); }
  };
  const addFiredTier = (tier: number) => {
    try {
      const set = getFiredTiers();
      set.add(tier);
      localStorage.setItem(firedTiersKey, JSON.stringify(Array.from(set)));
    } catch { /* storage full — ignore */ }
  };

  useEffect(() => {
    if (monthBalance <= 0 || totalUSD <= 0) return;
    const pct  = (totalUSD / monthBalance) * 100;
    const tier = totalUSD > monthBalance ? 4 : pct >= 95 ? 3 : pct >= 80 ? 2 : pct >= 50 ? 1 : 0;
    if (tier > 0 && !getFiredTiers().has(tier)) {
      addFiredTier(tier);
      const msgs: Record<number,string> = {
        1: "You've used 50% of your budget.",
        2: "80% of your budget used — nearing limit.",
        3: "95% reached — almost at your limit!",
        4: `Over budget by $${pin2(totalUSD - monthBalance).toFixed(2)}.`,
      };
      // Toast only — no push notification at tier 1 (informational)
      showToast(msgs[tier], tier >= 3 ? "warn" : "info");
      // Push notification at tier 2+ (≥80%) when permission granted
      if (tier >= 2 && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        new Notification("Apsara Spend — Budget Alert", {
          body: msgs[tier],
          icon: "/icon-192.png",
          tag: `budget-tier-${tier}-${selectedMonth}`, // unique per month
          silent: tier < 3,
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalUSD, monthBalance]);

  // TX1 — Auto-peek first row: open 40px then snap back to show swipe affordance
  useEffect(() => {
    if (hasSeenRowSwipe || !isLoaded) return;
    const monthKey = selectedMonth;
    const txsThisMonth = data.transactions.filter(t => t.date.startsWith(monthKey.replace("-", "-").slice(0, 7)));
    const firstId = txsThisMonth.sort((a, b) => b.date.localeCompare(a.date))[0]?.id;
    if (!firstId) return;
    const t1 = setTimeout(() => setOpenSwipeId(firstId), 1200);
    const t2 = setTimeout(() => {
      setOpenSwipeId(null);
      setHasSeenRowSwipe(true);
      localStorage.setItem("apsara_seen_row_swipe", "1");
    }, 1900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, hasSeenRowSwipe]);

  // TX2 — Close any open swipe row when the user scrolls (avoids stuck-open rows)
  useEffect(() => {
    if (!openSwipeId) return;
    const close = () => setOpenSwipeId(null);
    window.addEventListener("scroll", close, { passive: true });
    return () => window.removeEventListener("scroll", close);
  }, [openSwipeId]);

  // Reset visible count when month or filter changes so we always start at top
  useEffect(() => { setVisibleCount(10); }, [selectedMonth, filterCategory]);

  // ── Navigation ───────────────────────────────────────────────────────────────

  const navigateMonth = (delta: 1 | -1) => {
    const next = shiftMonth(selectedMonth, delta);
    if (delta === 1 && next > todayMonthKey()) {
      showToast("No future months.", "info");
      return;
    }
    setSwipeDir(delta);
    setSelectedMonth(next);
    setFilterCategory("all");
    setShowFilterMenu(false);
  };

  const handleDragEnd = (_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.x > 60)       navigateMonth(-1);
    else if (info.offset.x < -60) navigateMonth(1);
    // MN2 — hide swipe hint permanently after first swipe
    if (Math.abs(info.offset.x) > 60 && showSwipeHint) {
      setShowSwipeHint(false);
      localStorage.setItem("apsara_seen_swipe_hint", "1");
    }
  };

  // D2 — Optimistic CRUD: close the modal on the same frame as the user taps
  // "Add Expense" / "Save Changes". The UI feels instantaneous because the modal
  // is gone before the data re-render. setData happens synchronously in React's
  // batch, so the new entry appears in the list within the same paint cycle.
  const handleSave = (tx: Transaction) => {
    const wasEdit = !!editTx;
    // Close modal first — perceived latency = 0
    setShowModal(false);
    setEditTx(null);
    // Commit to state (D1 debounce batches the localStorage write)
    setData((d) => {
      const exists = d.transactions.some((t) => t.id === tx.id);
      return {
        ...d,
        transactions: exists
          ? d.transactions.map((t) => (t.id === tx.id ? tx : t))
          : [tx, ...d.transactions],
      };
    });
    showToast(wasEdit ? "Expense updated." : "Expense added.", "success");
  };

  const handleDelete = (id: string) => {
    // Find the tx before removing so we can restore it on Undo
    const deleted = data.transactions.find((t) => t.id === id);
    setShowModal(false);
    setEditTx(null);
    setConfirmDeleteTx(null);
    setOpenSwipeId(null);
    setData((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) }));
    const label = deleted?.note || CATEGORIES.find(c => c.id === deleted?.category)?.label || "Expense";
    showToast(`${label} deleted.`, "warn", deleted ? () => {
      setData((d) => {
        const already = d.transactions.some((t) => t.id === deleted.id);
        if (already) return d;
        return { ...d, transactions: [deleted, ...d.transactions] };
      });
      showToast("Expense restored.", "success");
    } : undefined);
  };

  const handleResetMonth = () => {
    // Snapshot deleted data before wiping so Undo can restore
    const deletedTxs = data.transactions.filter((t) => {
      const dt = new Date(t.date);
      return toMonthKey(dt.getFullYear(), dt.getMonth() + 1) === selectedMonth;
    });
    const deletedBalance = data.monthlyBalances[selectedMonth];

    setData((d) => {
      const transactions = d.transactions.filter((t) => {
        const dt = new Date(t.date);
        return toMonthKey(dt.getFullYear(), dt.getMonth() + 1) !== selectedMonth;
      });
      const monthlyBalances = { ...d.monthlyBalances };
      delete monthlyBalances[selectedMonth];
      return { ...d, transactions, monthlyBalances };
    });
    setResetConfirm(false);
    setShowSettings(false);
    showToast(`${MONTH_FULL[month - 1]} reset.`, "warn", () => {
      // Undo: restore deleted transactions and budget
      setData((d) => ({
        ...d,
        transactions: [...deletedTxs, ...d.transactions],
        monthlyBalances: deletedBalance
          ? { ...d.monthlyBalances, [selectedMonth]: deletedBalance }
          : d.monthlyBalances,
      }));
      showToast("Reset undone.", "success");
    });
  };

  // A1 — Flexible budget engine: budget can be set OR updated at any time.
  // Immutability rule from original spec §1 is removed to satisfy User 1 (flexible).
  // handleSetBudget handles both first-time set and mid-month edit.
  const isBalanceLocked = (_monthKey: string): boolean => false; // kept for API compat — always editable now

  // S1 — Budget gate: dashboard shows when any balance exists (> 0)
  const hasMonthBudget = (selectedMonth in data.monthlyBalances && data.monthlyBalances[selectedMonth] > 0);

  // A1/A2 — Save OR update the budget for selectedMonth.
  // No immutability lock — user can revise at any time (satisfies User 1).
  const handleSetBudget = () => {
    const amount = pin2(parseFloat(budgetInput) || 0);
    if (amount <= 0) { showToast("Enter a budget amount.", "info"); return; }
    const isEdit = selectedMonth in data.monthlyBalances && data.monthlyBalances[selectedMonth] > 0;
    setData((d) => ({
      ...d,
      monthlyBalances: { ...d.monthlyBalances, [selectedMonth]: amount },
    }));
    setBudgetInput("");
    setShowBudgetModal(false);
    showToast(
      isEdit
        ? `Budget updated to $${amount.toFixed(2)} for ${MONTH_FULL[month - 1]}.`
        : `Budget set to $${amount.toFixed(2)} for ${MONTH_FULL[month - 1]}.`,
      "success"
    );
  };

  const slideVariants = {
    enter:  (dir: number) => ({ x: dir > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit:   (dir: number) => ({ x: dir > 0 ? -80 : 80, opacity: 0 }),
  };

  // ─── Reusable card blocks ─────────────────────────────────────────────────────

  // ── Unified Summary + Breakdown card ────────────────────────────────────────
  // Merges both sections into one card with a hairline divider, eliminating
  // the ~50px dark gap that two separate cards with full padding create between
  // the budget bar labels and the BREAKDOWN eyebrow on mobile.
  const SummaryBreakdownCard = (
    <div style={{ background: "var(--color-bg-card)", borderRadius: 22, border: "1px solid var(--color-border)", overflow: "hidden", display: "flex", flexDirection: "column" }}>

      {/* ── Summary section ── */}
      <div style={{ padding: "24px 20px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--color-text-lo)", marginBottom: 4, fontFamily: "var(--font-body)", fontWeight: 400 }}>
              Total spent
            </div>
            <AnimatePresence mode="wait">
              <motion.div key={currency}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
                style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--color-text-hi)", lineHeight: 1, fontFamily: "var(--font-headline)" }}>
                {currency === "KHR"
                  ? `${Math.round(totalUSD * EXCHANGE_RATE).toLocaleString()} ៛`
                  : `$${totalUSD.toFixed(2)}`}
              </motion.div>
            </AnimatePresence>
            {/* F2 — Remaining / Over by: live balance feedback below the total */}
            {monthBalance > 0 && (() => {
              const remaining = pin2(monthBalance - totalUSD);
              const isOver    = remaining < 0;
              const tier      = isOver ? 4
                : (totalUSD / monthBalance) * 100 >= 95 ? 3
                : (totalUSD / monthBalance) * 100 >= 80 ? 2
                : (totalUSD / monthBalance) * 100 >= 50 ? 1 : 0;
              const tcolor = tier >= 4 ? "#ef4444" : tier === 3 ? "#f97316" : tier === 2 ? "#f59e0b" : tier === 1 ? "#3b82f6" : "#34d399";
              return (
                <motion.div
                  key={`${isOver}-${Math.floor(Math.abs(remaining) * 10)}`}
                  initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 5 }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: tcolor, flexShrink: 0, display: "inline-block" }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: tcolor, fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>
                    {isOver
                      ? `Over by $${Math.abs(remaining).toFixed(2)}`
                      : `Remaining $${remaining.toFixed(2)}`}
                  </span>
                </motion.div>
              );
            })()}
          </div>
          <div style={{ display: "flex", background: "var(--color-bg-page)", borderRadius: 10, padding: 3, gap: 3 }}>
            {(["USD", "KHR"] as Currency[]).map((c) => (
              <button key={c} onClick={() => setCurrency(c)}
                style={{
                  padding: "6px 11px", borderRadius: 7, border: "none", cursor: "pointer",
                  background: currency === c ? "var(--accent)" : "transparent",
                  color:      currency === c ? "#0d0f14" : "var(--color-text-lo)",
                  fontWeight: 700, fontSize: 12, fontFamily: "var(--font-body)", letterSpacing: "0.05em", transition: "all 0.18s",
                }}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <BudgetBar
          total={totalUSD}
          monthBudget={data.monthlyBalances[selectedMonth] ?? 0}
          onSetBudget={() => setShowBudgetModal(true)}
          onEditBudget={() => { setBudgetInput(monthBalance > 0 ? String(monthBalance) : ""); setShowBudgetModal(true); }}
        />
      </div>

      {/* ── Breakdown: category rows ── */}
      {hasBreakdown && (
        <>
          <div style={{ height: 1, background: "var(--color-border)", margin: "0 24px" }} />
          <div style={{ padding: "16px 20px 24px" }}>
            {categoryTotals.filter((c) => c.total > 0).map((c, i) => {
              const pct = totalUSD > 0 ? (c.total / totalUSD) * 100 : 0;
              return (
                <motion.div key={c.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, duration: 0.2 }}
                  style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: i < categoryTotals.filter(x => x.total > 0).length - 1 ? 12 : 0 }}>
                  <CategoryIcon cat={c} active />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, alignItems: "baseline" }}>
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>{c.label}</span>
                        <span style={{ fontSize: 10, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", marginLeft: 6, opacity: 0.7 }}>
                          {c.count} {c.count === 1 ? "item" : "items"}
                        </span>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c.color, fontFamily: "var(--font-mono)" }}>{fmt(c.total)}</span>
                    </div>
                    <div style={{ background: "var(--color-bg-nav)", borderRadius: 999, height: 4, overflow: "hidden" }}>
                      <motion.div animate={{ width: `${pct}%` }} transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
                        style={{ height: "100%", background: c.color, borderRadius: 999 }} />
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  const EmptyState = (
    <div style={{ textAlign: "center", padding: "48px 20px", background: "var(--color-bg-card)", borderRadius: 22, border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>

      <svg
        width="120" height="80"
        viewBox="0 0 120 80"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ marginBottom: 16 }}
      >
        <rect x="8" y="28" width="88" height="44" rx="8" fill="var(--color-bg-nav)" />
        <path d="M8 36 Q8 28 16 28 H80 Q88 28 88 36 V44 H8 Z" fill="var(--color-bg-nav)" />
        <line x1="8" y1="44" x2="88" y2="44" stroke="var(--color-border-mid)" strokeWidth="1" />
        <rect x="16" y="50" width="40" height="14" rx="3" fill="var(--color-bg-nav)" stroke="var(--color-border-mid)" strokeWidth="1" />
        <rect x="20" y="54" width="12" height="2" rx="1" fill="var(--color-border-mid)" />
        <circle cx="90" cy="22" r="14" fill="var(--accent-muted)" stroke="var(--accent)" strokeWidth="1.5" />
        <text x="90" y="27" textAnchor="middle" fill="var(--accent)" fontSize="12" fontWeight="700" fontFamily="system-ui">$</text>
        <circle cx="108" cy="10" r="2"   fill="var(--accent-border)" />
        <circle cx="114" cy="18" r="1.5" fill="var(--accent-border)" />
        <circle cx="104" cy="4"  r="1"   fill="var(--accent-border)" />
        <line x1="62" y1="54" x2="78" y2="54" stroke="var(--color-border-mid)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
        <line x1="62" y1="58" x2="74" y2="58" stroke="var(--color-border-mid)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
      </svg>

      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.4 }}>Nothing here yet</div>
      <div style={{ fontSize: 12, marginTop: 6, color: "var(--color-text-ghost)", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>Add your first expense to start tracking.</div>
    </div>
  );

  // ── L2/L3: filtered + sorted transactions ─────────────────────────────────
  const activeCat   = CATEGORIES.find((c) => c.id === filterCategory);
  const filteredTxs = useMemo(() =>
    filterCategory === "all"
      ? [...monthTxs]
      : [...monthTxs].filter((t) => t.category === filterCategory),
    [monthTxs, filterCategory]
  );

  const TransactionList = hasData ? (
    <div style={{ background: "var(--color-bg-card)", borderRadius: 22, padding: "20px 20px 24px", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column" }}>

      {/* ── Filter chips — horizontal scroll. onPointerDownCapture stops propagation
           to the parent motion.div drag handler so scrolling chips doesn't trigger
           month navigation — both gestures coexist independently ── */}
      <div
        style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", paddingBottom: 2, scrollbarWidth: "none", WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}
        onPointerDownCapture={(e) => e.stopPropagation()}
        onTouchStartCapture={(e) => e.stopPropagation()}
      >
        {/* All chip */}
        <button
          onClick={() => setFilterCategory("all")}
          style={{
            flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
            padding: "5px 12px", borderRadius: 99,
            border: filterCategory === "all" ? "none" : "1px solid var(--color-border-mid)",
            background: filterCategory === "all" ? "var(--accent)" : "var(--color-bg-nav)",
            color: filterCategory === "all" ? "var(--accent-text)" : "var(--color-text-lo)",
            fontSize: 12, fontWeight: 600, fontFamily: "var(--font-body)",
            cursor: "pointer", transition: "all 0.15s",
            whiteSpace: "nowrap",
          }}>
          All
        </button>
        {/* Category chips — only for categories with entries */}
        {CATEGORIES.filter(c => monthTxs.some(t => t.category === c.id)).map(c => {
          const active = filterCategory === c.id;
          return (
            <button key={c.id}
              onClick={() => setFilterCategory(active ? "all" : c.id)}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
                padding: "5px 10px", borderRadius: 99,
                border: active ? "none" : "1px solid var(--color-border-mid)",
                background: active ? c.color : "var(--color-bg-nav)",
                color: active ? "#fff" : "var(--color-text-lo)",
                fontSize: 12, fontWeight: active ? 600 : 400, fontFamily: "var(--font-body)",
                cursor: "pointer", transition: "all 0.15s",
                whiteSpace: "nowrap",
              }}>
              <c.Icon size={11} color={active ? "#fff" : c.color} strokeWidth={2} />
              {c.label}
            </button>
          );
        })}
      </div>

      {/* ── Transaction rows (filtered) ── */}
      {filteredTxs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px 0", color: "var(--color-text-lo)", fontSize: 13, fontFamily: "var(--font-body)" }}>
          No {activeCat?.label} entries this month
        </div>
      ) : (() => {
        const sorted = [...filteredTxs].sort((a, b) =>
          new Date(b.date).getTime() - new Date(a.date).getTime() ||
          b.id.localeCompare(a.id)
        );
        const visible  = sorted.slice(0, visibleCount);
        const hasMore  = visibleCount < sorted.length;

        // TX3 — build a set of dates that need a group header above them
        const todayStr     = localDateString();
        const yesterdayStr = localDateString(new Date(Date.now() - 86400000));
        const dateLabel    = (d: string) =>
          d === todayStr     ? "Today"
          : d === yesterdayStr ? "Yesterday"
          : formatDisplayDate(d);
        const seenDates = new Set<string>();
        return (
          <>
            {visible.map((tx, i) => {
            const cat      = CATEGORIES.find((c) => c.id === tx.category) ?? CATEGORIES[5];
            const dateStr  = formatDisplayDate(localDateString(new Date(tx.date)));
            const txDate   = localDateString(new Date(tx.date));
            const isFirst  = !seenDates.has(txDate);
            if (isFirst) seenDates.add(txDate);
            const isLast   = i === visible.length - 1 && !hasMore;
            const isOpen   = openSwipeId === tx.id;
            return (
              <React.Fragment key={tx.id}>
              {isFirst && (
                <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", padding: i === 0 ? "2px 0 6px" : "14px 0 6px" }}>
                  {dateLabel(txDate)}
                </div>
              )}
              <div style={{ position: "relative", overflow: "hidden",
                borderBottom: isLast ? "none" : "1px solid var(--color-border)" }}>

                {/* Swipe reveal — DELETE only (full width). Row tap = edit. */}
                <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 80, display: "flex" }}>
                  <button
                    onClick={() => { setConfirmDeleteTx(tx); setOpenSwipeId(null); }}
                    style={{
                      flex: 1, border: "none", cursor: "pointer",
                      background: "#ef4444",
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                    }}>
                    <Trash2 size={16} color="#fff" strokeWidth={2} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: "#fff", fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}>DELETE</span>
                  </button>
                </div>

                {/* Draggable row — constraint -80 matches the 80px DELETE reveal */}
                <motion.div
                  drag="x"
                  dragDirectionLock
                  dragConstraints={{ left: -80, right: 0 }}
                  dragElastic={{ left: 0.06, right: 0 }}
                  animate={{ x: isOpen ? -80 : 0 }}
                  transition={{ type: "spring", damping: 30, stiffness: 300 }}
                  onDragStart={() => { dragStarted.current = true; }}
                  onDragEnd={(_e, info) => {
                    // Snap open if past 60px threshold, otherwise snap closed
                    if (info.offset.x < -60) {
                      setOpenSwipeId(tx.id);
                    } else {
                      setOpenSwipeId(null);
                    }
                    // S4 — clear drag flag after brief delay so click doesn't fire
                    setTimeout(() => { dragStarted.current = false; }, 120);
                  }}
                  style={{ background: "var(--color-bg-card)", position: "relative", zIndex: 1, touchAction: "pan-y" }}
                >
                  <motion.button
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
                    aria-label={`${tx.note || cat.label}, ${fmt(tx.amountUSD)}, ${dateStr}. Press E to edit, Delete to remove.`}
                    onClick={() => {
                      // S4 — block accidental edit if drag just finished
                      if (dragStarted.current) return;
                      if (isOpen) { setOpenSwipeId(null); return; }
                      setEditTx(tx); setShowModal(true);
                    }}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 0",
                      background: "none", border: "none",
                      cursor: "pointer", textAlign: "left",
                    }}>
                    <CategoryIcon cat={cat} active />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                        {tx.note}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--color-text-lo)", marginTop: 4, fontFamily: "var(--font-body)", lineHeight: 1.4 }}>
                        {cat.label} · {dateStr}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text-hi)", fontFamily: "var(--font-mono)" }}>
                        {fmt(tx.amountUSD)}
                      </span>
                    </div>
                  </motion.button>
                </motion.div>
              </div>
              </React.Fragment>
            );
          })}

          {/* I3 — Skeleton rows while more items exist below the fold */}
          {hasMore && [0,1].map(j => (
            <div key={`skel-${j}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0",
              borderBottom: "1px solid var(--color-border)" }}>
              <div className="skeleton skeleton-circle" style={{ width: 40, height: 40, flexShrink: 0 }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="skeleton skeleton-round" style={{ width: `${j === 0 ? 65 : 78}%`, height: 13 }} />
                <div className="skeleton skeleton-round" style={{ width: "40%", height: 10 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}>
                <div className="skeleton skeleton-round" style={{ width: 52, height: 13 }} />
                <div className="skeleton skeleton-round" style={{ width: 28, height: 10 }} />
              </div>
            </div>
          ))}

          {/* I2 — Sentinel: callback ref fires IntersectionObserver when this div mounts */}
          <div ref={loadMoreRef} style={{ height: 4 }} />
          </>
        );
      })()}
    </div>
  ) : null;

  // ── S2  Initialize Screen ────────────────────────────────────────────────────
  // Shown when no monthly budget has been set yet. Gates the full dashboard
  // behind the sequential flow: budget first → then expense tracking.
  const InitScreen = (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", textAlign: "center",
        padding: "48px 32px",
      }}
    >
      {/* Wallet illustration */}
      <svg width="140" height="96" viewBox="0 0 120 80" fill="none"
        xmlns="http://www.w3.org/2000/svg" aria-hidden="true"
        style={{ marginBottom: 28 }}>
        <rect x="8" y="28" width="88" height="44" rx="8" fill="var(--color-border-mid)" />
        <path d="M8 36 Q8 28 16 28 H80 Q88 28 88 36 V44 H8 Z" fill="var(--color-bg-deep)" />
        <line x1="8" y1="44" x2="88" y2="44" stroke="var(--color-border)" strokeWidth="1" />
        <rect x="16" y="50" width="40" height="14" rx="3" fill="var(--color-bg-deep)" stroke="var(--color-border)" strokeWidth="1" />
        <rect x="20" y="54" width="12" height="2" rx="1" fill="var(--color-border)" />
        <circle cx="90" cy="22" r="14" fill="var(--accent-muted)" stroke="var(--accent)" strokeWidth="1.5" />
        <text x="90" y="27" textAnchor="middle" fill="var(--accent)" fontSize="12" fontWeight="700" fontFamily="system-ui">$</text>
        <circle cx="108" cy="10" r="2"   fill="var(--accent-border)" />
        <circle cx="114" cy="18" r="1.5" fill="var(--accent-border)" />
        <circle cx="104" cy="4"  r="1"   fill="var(--accent-border)" />
        <line x1="62" y1="54" x2="78" y2="54" stroke="var(--color-border)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
        <line x1="62" y1="58" x2="74" y2="58" stroke="var(--color-border)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
      </svg>

      <div style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", letterSpacing: "-0.01em", lineHeight: 1.25, marginBottom: 10 }}>
        What's your {MONTH_FULL[month - 1]} budget?
      </div>
      <div style={{ fontSize: 14, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.6, marginBottom: 32, maxWidth: 280 }}>
        You can always adjust it later.
      </div>

      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={() => setShowBudgetModal(true)}
        className="btn-primary"
        style={{
          padding: "15px 32px",
          fontSize: 16, fontFamily: "var(--font-headline)",
          letterSpacing: "0.02em",
          display: "flex", alignItems: "center", gap: 8,
        }}
      >
        Set budget
      </motion.button>

    </motion.div>
  );

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        :root {
          --font-headline: 'Poppins', system-ui, sans-serif;
          --font-body:     'Open Sans', system-ui, sans-serif;
          --font-mono:     'DM Mono', ui-monospace, monospace;

          /* ── Grid-8 spacing tokens (base unit = 8px) ─────────────────── */
          --sp-1:  4px;
          --sp-2:  8px;
          --sp-3:  12px;
          --sp-4:  16px;
          --sp-5:  20px;
          --sp-6:  24px;
          --sp-8:  32px;
          --sp-10: 40px;
          --sp-12: 48px;
          --sp-14: 56px;

          /* ── Q1  Accent token system ─────────────────────────────────── */
          /* Default palette: Yellow. All accent-bearing elements use these  */
          /* vars so a single class swap repaints the entire UI.             */
          --accent:      #fbbf24;   /* primary buttons, FAB, progress fill   */
          --accent-dim:  #f59e0b;   /* gradient endpoint, hover states       */
          --accent-text: #0d0f14;   /* text on --accent background           */
          --accent-glow: rgba(251,191,36,0.35); /* shadow/glow               */
          --accent-muted: rgba(251,191,36,0.12); /* tinted bg               */
          --accent-border: rgba(251,191,36,0.35); /* tinted border          */
        }

        /* ── Q1  Palette classes — applied to <html> element ────────────── */
        /* Yellow / Dark (default — same as :root above)                      */
        html.palette-yellow {
          --accent: #fbbf24; --accent-dim: #f59e0b;
          --accent-text: #0d0f14;
          --accent-glow: rgba(251,191,36,0.35);
          --accent-muted: rgba(251,191,36,0.12);
          --accent-border: rgba(251,191,36,0.35);
        }
        /* Indigo / Dark */
        html.palette-indigo {
          --accent: #818cf8; --accent-dim: #6366f1;
          --accent-text: #0d0f14;
          --accent-glow: rgba(129,140,248,0.35);
          --accent-muted: rgba(129,140,248,0.12);
          --accent-border: rgba(129,140,248,0.35);
        }
        /* Emerald / Dark */
        html.palette-emerald {
          --accent: #34d399; --accent-dim: #10b981;
          --accent-text: #0d0f14;
          --accent-glow: rgba(52,211,153,0.35);
          --accent-muted: rgba(52,211,153,0.12);
          --accent-border: rgba(52,211,153,0.35);
        }
        /* Rose / Dark */
        html.palette-rose {
          --accent: #fb7185; --accent-dim: #f43f5e;
          --accent-text: #0d0f14;
          --accent-glow: rgba(251,113,133,0.35);
          --accent-muted: rgba(251,113,133,0.12);
          --accent-border: rgba(251,113,133,0.35);
        }

        /* ── Q3 / T1  Theme tokens — dark (default) ─────────────────────── */
        :root {
          --color-bg-page:     #080b10;
          --color-bg-card:     #0f131a;
          --color-bg-input:    #141920;
          --color-bg-deep:     #080b10;
          --color-bg-nav:      #141920;
          --color-border:      #1a2333;
          --color-border-mid:  #1e2a38;
          --color-text-hi:     #f8fafc;
          --color-text-mid:    #cbd5e1;
          --color-text-lo:     #94a3b8;  /* 7.7:1 on dark bg — WCAG AA ✓ (was #475569 = 2.6:1 ✗) */
          --color-text-ghost:  #475569;  /* decorative only — swipe hint, dividers                */
          /* Toast — dark mode: deep coloured surfaces */
          --toast-warn-bg:     #1c1008;
          --toast-warn-border: #92400e;
          --toast-warn-text:   #fde68a;
          --toast-ok-bg:       #051f12;
          --toast-ok-border:   #047857;
          --toast-ok-text:     #6ee7b7;
          --toast-info-bg:     #0c1829;
          --toast-info-border: #1d4ed8;
          --toast-info-text:   #bfdbfe;
          --toast-shadow:      0 8px 32px rgba(0,0,0,0.6);
        }
        /* ── T1  Light mode: Slate-50 bg, Slate-900 text (WCAG AA) ──────── */
        html[data-theme="light"] {
          --color-bg-page:     #f8fafc;   /* Slate-50  */
          --color-bg-card:     #ffffff;   /* White     */
          --color-bg-input:    #ffffff;   /* White — active inputs stand out clearly */
          --color-bg-deep:     #e2e8f0;   /* Slate-200 */
          --color-bg-nav:      #f1f5f9;   /* Slate-100 */
          --color-border:      #e2e8f0;   /* Slate-200 */
          --color-border-mid:  #cbd5e1;   /* Slate-300 */
          --color-text-hi:     #0f172a;   /* Slate-900 — 16:1 on white ✓  */
          --color-text-mid:    #334155;   /* Slate-700 — 10:1 ✓           */
          --color-text-lo:     #475569;   /* Slate-600 — 6.6:1 ✓          */
          --color-text-ghost:  #94a3b8;   /* Slate-400 — decorative only  */
          /* Toast — light mode: soft tinted surfaces, dark text, minimal shadow */
          --toast-warn-bg:     #fffbeb;
          --toast-warn-border: #f59e0b;
          --toast-warn-text:   #92400e;
          --toast-ok-bg:       #ecfdf5;
          --toast-ok-border:   #10b981;
          --toast-ok-text:     #065f46;
          --toast-info-bg:     #eff6ff;
          --toast-info-border: #3b82f6;
          --toast-info-text:   #1e40af;
          --toast-shadow:      0 2px 12px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.06);
        }
        html[data-theme="light"], html[data-theme="light"] body {
          background: var(--color-bg-page);
          color: var(--color-text-hi);
        }
        /* ── T2  Utility surface classes — apply these to cards/inputs ──── */
        /* All theme changes flow through CSS vars; no JS required.           */
        .surface-page  { background: var(--color-bg-page)  !important; }
        .surface-card  { background: var(--color-bg-card)  !important; border-color: var(--color-border) !important; color: var(--color-text-hi) !important; }
        .surface-input { background: var(--color-bg-input) !important; border-color: var(--color-border-mid) !important; color: var(--color-text-hi) !important; }
        .surface-deep  { background: var(--color-bg-deep)  !important; }
        .surface-nav   { background: var(--color-bg-nav)   !important; border-color: var(--color-border-mid) !important; }
        .text-hi   { color: var(--color-text-hi)    !important; }
        .text-mid  { color: var(--color-text-mid)   !important; }
        .text-lo   { color: var(--color-text-lo)    !important; }

        /* Focus ring uses accent var */
        /* ── Unified input system ────────────────────────────────────────── */
        /* All text/number/date inputs share the same default + focus states   */
        /* Default:  1.5px var(--color-border), bg: var(--color-bg-input)      */
        /* Focus:    accent border + 3px accent-muted ring                      */
        /* Disabled: opacity 0.45, cursor not-allowed                           */
        .input-field {
          background: var(--color-bg-input);
          border: 1.5px solid var(--color-border);
          border-radius: 12px;
          color: var(--color-text-hi);
          outline: none;
          transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
        }
        .input-field:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-muted);
        }
        .input-field:disabled,
        .input-field[aria-disabled="true"] {
          background: var(--color-bg-nav);   /* gray — clearly inactive */
          opacity: 0.55;
          cursor: not-allowed;
        }
        /* Light mode override: disabled = Slate-100, active = white */
        html[data-theme="light"] .input-field:disabled,
        html[data-theme="light"] .input-field[aria-disabled="true"] {
          background: #f1f5f9;
        }

        /* Input field — shared style for default + focus states              */
        /* Default: subtle border. Focus: accent border + faint glow ring.    */
        .focus-input {
          border: 1.5px solid var(--color-border) !important;
          transition: border-color 0.18s, box-shadow 0.18s !important;
        }
        .focus-input:focus {
          border-color: var(--accent) !important;
          box-shadow: 0 0 0 3px var(--accent-muted) !important;
          outline: none !important;
        }

        /* ── Unified button system ───────────────────────────────────────── */
        /* Primary: accent gradient, 14px radius, 14–16px padding             */
        /* Secondary/ghost: bg-nav, border, text-lo                           */
        /* Disabled: bg-nav, border-mid, text-lo, opacity 0.5, not-allowed    */
        .btn-primary {
          background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%);
          color: var(--accent-text);
          border: none;
          border-radius: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: opacity 0.2s, box-shadow 0.2s;
        }
        .btn-primary:hover   { opacity: 0.92; }
        .btn-primary:active  { opacity: 0.85; }
        .btn-primary:disabled,
        .btn-primary[aria-disabled="true"] {
          background: var(--color-bg-nav);
          color: var(--color-text-lo);
          border: 1px solid var(--color-border-mid);
          opacity: 0.6;
          cursor: not-allowed;
        }
        .btn-ghost {
          background: var(--color-bg-nav);
          color: var(--color-text-lo);
          border: 1px solid var(--color-border-mid);
          border-radius: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }
        .btn-ghost:hover { background: var(--color-border-mid); }

        /* HD3 — Focus ring: 3px offset + 2px width ensures ≥3:1 contrast in light mode */
        button:focus { outline: none; }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }

        /* Fix 4 — Placeholder text uses --color-text-hi so it reads correctly in light mode */
        ::placeholder { color: var(--color-text-lo); opacity: 1; }
        input::placeholder, textarea::placeholder { color: var(--color-text-lo); opacity: 1; }

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        html { font-size: 16px; }
        html, body {
          background: var(--color-bg-page);
          min-height: 100dvh;
          overscroll-behavior: none;
          font-family: var(--font-body);
          font-size: 1rem;
          line-height: 1.6;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; }
        input[type=number]  { -moz-appearance: textfield; }
        input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.4); }
        ::-webkit-scrollbar { width: 0; }

        /* ── Responsive icon sizing ─────────────────────────────────────── */
        .icon-nav { width: 16px; height: 16px; }
        .icon-cat { width: 16px; height: 16px; }
        @media (min-width: 768px) {
          .icon-nav { width: 24px; height: 24px; }
          .icon-cat { width: 20px; height: 20px; }
        }

        /* ── Layout Shifter — Grid-8 aligned ────────────────────────────── */
        /* Mobile-first: single-column stack, max 430px                      */
        .main-wrap    { max-width: 430px; margin: 0 auto; }

        /* ── H1/H2  Sticky header ─────────────────────────────────────────── */
        /* Wraps header-pad + monthnav-pad. Sticks to top while content scrolls. */
        /* backdrop-filter blurs the page content scrolling underneath.          */
        .sticky-header {
          position: sticky;
          top: 0;
          z-index: 30;
          backdrop-filter: blur(16px) saturate(1.4);
          -webkit-backdrop-filter: blur(16px) saturate(1.4);
          background: color-mix(in srgb, var(--color-bg-page) 95%, transparent);
          border-bottom: 0.5px solid color-mix(in srgb, var(--color-border) 60%, transparent);
        }

        /* H2 — safe-area-inset-top lives in the sticky header, not header-pad */
        /* header-pad top padding only needs to clear the internal card spacing */
        /* Mobile: sp-4(16px) sides aligns header with card edges              */
        .header-pad   { padding: max(var(--sp-6), env(safe-area-inset-top)) var(--sp-4) var(--sp-2); }
        .monthnav-pad { padding: var(--sp-3) var(--sp-4) var(--sp-3); }

        /* Tablet / Desktop */
        @media (min-width: 768px) {
          .main-wrap    { max-width: 900px; }
          .header-pad   { padding: max(var(--sp-6), env(safe-area-inset-top)) var(--sp-8) var(--sp-2); }
          .monthnav-pad { padding: var(--sp-3) var(--sp-8) var(--sp-4); }
        }

        /* FAB floating: main scroll needs enough bottom padding so the last   */
        /* expense row is never hidden behind the FAB on any screen height.    */
        @media (min-width: 768px) {
          .main-scroll { padding-bottom: calc(var(--sp-8) + env(safe-area-inset-bottom)) !important; }
        }

        /* Dashboard card grid — always single column flex stack ──────────── */
        /* H3 — padding-top compensates for sticky header so summary card     */
        /* is not clipped on initial render. ~140px header height on mobile.  */
        /* Mobile: 12px sides so cards sit 12px from screen edge              */
        .dash-pad  { padding: var(--sp-3) var(--sp-3) 0; display: flex; flex-direction: column; gap: var(--sp-3); }
        @media (min-width: 768px) {
          .dash-pad  { padding: var(--sp-4) var(--sp-8) 0; gap: var(--sp-4); }
          .col-left  { display: flex; flex-direction: column; gap: var(--sp-4); }
          .col-right { display: flex; flex-direction: column; }
        }

        /* ── FAB — Floating Action Button (mobile + desktop) ─────────────── */
        /* Mobile-first: circular pill at bottom-right, floating above content  */
        /* High elevation shadow + safe-area clearance for home indicator        */
        .fab-footer {
          position: fixed;
          bottom: calc(var(--sp-8) + env(safe-area-inset-bottom));
          right: var(--sp-5);
          z-index: 50;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
        }
        .fab-btn {
          /* Pill shape on mobile: icon + label */
          width: auto;
          display: flex;
        }
        /* Desktop: align to right edge of main-wrap container */
        @media (min-width: 768px) {
          .fab-footer {
            bottom: calc(var(--sp-8) + env(safe-area-inset-bottom));
            right: calc(50% - 450px + var(--sp-8));
          }
        }

        /* ── Responsive modals: bottom-sheet on mobile, centred on tablet+ ── */
        /* Mobile default: sheet slides up from bottom                         */
        .modal-backdrop   { align-items: flex-end !important; }
        .modal-sheet      { border-radius: 24px 24px 0 0 !important; border-bottom: none !important; max-height: 92dvh; overflow-y: auto; }
        /* Tablet+: centred floating dialog                                    */
        @media (min-width: 768px) {
          .modal-backdrop  { align-items: center !important; justify-content: center !important; padding: 32px !important; }
          .modal-sheet     { border-radius: 20px !important; border-bottom: 1px solid var(--color-border-mid) !important; max-height: 88dvh; }
        }
        .date-input { width: 100%; box-sizing: border-box; }
        @media (min-width: 768px) {
          .date-input { width: auto; min-width: 200px; }
        }

        /* ── D6  Swipe hint fade-in — 800ms delay after dashboard renders ─ */
        @keyframes hintFade { from { opacity: 0; } to { opacity: 1; } }
        .swipe-hint { animation: hintFade 0.5s ease 0.8s both; }

        @keyframes nudge {
          0%, 100% { transform: translateX(0); }
          20%       { transform: translateX(-6px); }
          40%       { transform: translateX(6px); }
          60%       { transform: translateX(-4px); }
          80%       { transform: translateX(4px); }
        }
        .btn-nudge { animation: nudge 0.35s ease; }

        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 0 16px var(--accent-glow); }
          50%       { box-shadow: 0 0 28px var(--accent-glow); }
        }
        @keyframes budgetPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.7; }
        }
        @keyframes shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position:  200% 0; }
        }
        /* FA3 — Disable looping animations for users who prefer reduced motion */
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
          .skeleton { animation: none !important; background: var(--color-bg-nav); }
        }
        /* J1 — SkeletonCard: uses CSS vars so it adapts to light/dark theme */
        .skeleton {
          background: linear-gradient(90deg,
            var(--color-bg-nav) 25%,
            var(--color-border-mid) 50%,
            var(--color-bg-nav) 75%
          );
          background-size: 200% 100%;
          animation: shimmer 1.4s ease-in-out infinite;
          border-radius: 12px;
        }
        .skeleton-round  { border-radius: 99px; }  /* for pill/badge shapes  */
        .skeleton-circle { border-radius: 50%;  }  /* for icon/avatar shapes */
      `}</style>

      {/* ════ K1  SPLASH SCREEN — covers localStorage hydration ════ */}
      {/* AnimatePresence keeps the exit animation alive after showSplash flips false */}
      <AnimatePresence>
        {showSplash && (
          <motion.div
            key="splash"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.04 }}
            transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            style={{
              position: "fixed", inset: 0, zIndex: 999,
              background: "var(--color-bg-page)",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 0,
            }}
          >
            {/* Logo mark — scaled-up wallet SVG */}
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
              style={{ marginBottom: 28 }}
            >
              <svg width="96" height="96" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                {/* Outer card body */}
                <rect x="8" y="28" width="80" height="52" rx="12" fill="var(--color-border-mid)" />
                {/* Card top strip */}
                <path d="M8 40 Q8 28 20 28 H76 Q88 28 88 40 V52 H8 Z" fill="var(--color-bg-nav)" />
                {/* Horizontal divider */}
                <line x1="8" y1="52" x2="88" y2="52" stroke="var(--color-border)" strokeWidth="1.5" />
                {/* Card slot */}
                <rect x="16" y="60" width="36" height="12" rx="4" fill="var(--color-bg-deep)" stroke="var(--color-border)" strokeWidth="1.5" />
                {/* Chip lines */}
                <rect x="20" y="64" width="10" height="1.5" rx="1" fill="var(--color-border-mid)" />
                <rect x="20" y="67" width="7" height="1.5" rx="1" fill="var(--color-border-mid)" />
                {/* Accent coin */}
                <circle cx="72" cy="26" r="18" fill="var(--accent-muted)" stroke="var(--accent)" strokeWidth="2" />
                {/* Dollar sign */}
                <text x="72" y="32" textAnchor="middle" fill="var(--accent)" fontSize="18" fontWeight="800" fontFamily="system-ui">$</text>
                {/* Sparkle dots */}
                <circle cx="18" cy="18" r="2.5" fill="var(--accent-border)" />
                <circle cx="10" cy="26" r="1.5" fill="var(--accent-border)" />
                <circle cx="24" cy="10" r="1.5" fill="var(--accent-border)" />
              </svg>
            </motion.div>

            {/* Wordmark */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.12, ease: [0.4, 0, 0.2, 1] }}
              style={{ textAlign: "center" }}
            >
              <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", lineHeight: 1.1, marginBottom: 8 }}>
                Apsara <span style={{ color: "var(--accent)" }}>Spend</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}>
                Your personal budget tracker
              </div>
            </motion.div>

            {/* Loading indicator */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3, duration: 0.3 }}
              style={{ position: "absolute", bottom: "10%", display: "flex", alignItems: "center", gap: 6 }}
            >
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, delay: i * 0.18, repeat: Infinity, ease: "easeInOut" }}
                  style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }}
                />
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ════ GN1  FIRST-RUN ONBOARDING — 3-step tooltip overlay ════ */}
      <AnimatePresence>
        {showOnboarding && (() => {
          const steps: { Icon: React.FC<React.SVGProps<SVGSVGElement>>, color: string, title: string, body: string, hint: string }[] = [
            {
              Icon: CalendarDays as React.FC<React.SVGProps<SVGSVGElement>>,
              color: "var(--accent)",
              title: "Start with a budget",
              body: "Set a monthly budget and every expense will track against it — you'll always know what's left.",
              hint: "You can update your budget at any time. It's not locked in.",
            },
            {
              Icon: Plus as React.FC<React.SVGProps<SVGSVGElement>>,
              color: "var(--accent)",
              title: "Log an expense",
              body: "Tap Add Expense to log anything. Choose USD or KHR, pick a category, and add a note.",
              hint: "Switch between currencies — values convert automatically.",
            },
            {
              Icon: Trash2 as React.FC<React.SVGProps<SVGSVGElement>>,
              color: "#ef4444",
              title: "Swipe to delete",
              body: "Swipe any expense left to reveal the Delete button. Tap a row to edit it.",
              hint: "You have 5 seconds to undo any deletion.",
            },
            {
              Icon: Settings as React.FC<React.SVGProps<SVGSVGElement>>,
              color: "var(--color-text-lo)",
              title: "Customise",
              body: "Open Settings to switch themes, pick your accent colour, and set budget alert notifications.",
              hint: "Budget mode: Soft warns, Hard requires a confirmation to go over.",
            },
          ];
          const step = steps[onboardStep];
          const isLast = onboardStep === steps.length - 1;
          const dismiss = () => {
            setShowOnboarding(false);
            localStorage.setItem("apsara_onboarded_v2", "1");
          };
          const StepIcon = step.Icon;
          return (
            <motion.div
              key="onboarding"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.84)", zIndex: 900, display: "flex", alignItems: "flex-end", justifyContent: "center", padding: "0 12px calc(20px + env(safe-area-inset-bottom))" }}
              onClick={dismiss}
            >
              <motion.div
                key={onboardStep}
                initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                transition={{ type: "spring", damping: 28, stiffness: 320 }}
                style={{ background: "var(--color-bg-card)", borderRadius: 24, padding: "28px 24px 20px", width: "100%", maxWidth: 440, border: "1px solid var(--color-border-mid)" }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Step counter + dots */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>
                    {onboardStep + 1} of {steps.length}
                  </span>
                  <div style={{ display: "flex", gap: 5 }}>
                    {steps.map((_, i) => (
                      <div key={i} style={{ width: i === onboardStep ? 18 : 5, height: 5, borderRadius: 99, background: i === onboardStep ? "var(--accent)" : "var(--color-border-mid)", transition: "all 0.25s" }} />
                    ))}
                  </div>
                </div>

                {/* Icon in accent pill */}
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                  <div style={{ width: 60, height: 60, borderRadius: 18, background: step.color === "var(--accent)" ? "var(--accent-muted)" : "#ef444415", border: `1px solid ${step.color === "var(--accent)" ? "var(--accent-border)" : "#ef444435"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <StepIcon style={{ width: 26, height: 26, color: step.color, stroke: step.color }} />
                  </div>
                </div>

                {/* Title + body */}
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", textAlign: "center", marginBottom: 8, letterSpacing: "-0.01em" }}>{step.title}</div>
                <div style={{ fontSize: 14, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", textAlign: "center", lineHeight: 1.65, marginBottom: 14 }}>{step.body}</div>

                {/* Hint chip */}
                <div style={{ background: "var(--color-bg-page)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "8px 14px", marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <Lightbulb size={13} color="var(--color-text-lo)" strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.55 }}>{step.hint}</span>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={dismiss}
                    style={{ padding: "12px 0", borderRadius: 12, border: "1px solid var(--color-border-mid)", background: "transparent", color: "var(--color-text-lo)", fontSize: 13, fontFamily: "var(--font-body)", cursor: "pointer", flex: 1 }}>
                    Skip
                  </button>
                  <button
                    onClick={() => isLast ? dismiss() : setOnboardStep((s) => s + 1)}
                    className="btn-primary"
                    style={{ padding: "12px 0", fontSize: 14, fontFamily: "var(--font-body)", flex: 2 }}>
                    {isLast ? "Set my budget" : "Next"}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      <main className="main-wrap"
        style={{
          fontFamily: "var(--font-body)",
          background: "var(--color-bg-page)",
          minHeight: "100dvh",
          color: "var(--color-text-mid)",
          position: "relative",
          userSelect: "none",
        }}
      >
        <div className="main-scroll" style={{ position: "relative", zIndex: 1, paddingBottom: "calc(160px + env(safe-area-inset-bottom))" }}>

          {/* ════ STICKY HEADER — app title + month navigation ════ */}
          <div className="sticky-header">

          {/* ════ HEADER ════ */}
          <div className="header-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            {/* J2 — Header skeleton while hydrating */}
            {!isLoaded ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
                <div className="skeleton skeleton-round" style={{ width: 180, height: 28 }} />
                <div className="skeleton skeleton-round" style={{ width: 140, height: 10 }} />
              </div>
            ) : (
            <div>
              <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", margin: 0, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", lineHeight: 1.1 }}>
                Apsara <span style={{ color: "var(--accent)" }}>Spend</span>
              </h1>
              <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.06em", marginTop: 6, fontFamily: "var(--font-body)", display: "flex", alignItems: "center", gap: 8 }}>
                1 USD = 4,000 ៛ · Fixed rate
              </div>
            </div>
            )}
            {/* Settings button always visible */}
            <button aria-label="Open settings" onClick={() => setShowSettings(true)}
              style={{ background: "var(--color-bg-nav)", border: "1px solid var(--color-border-mid)", borderRadius: 12, padding: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44, marginTop: 4 }}>
              <Settings className="icon-nav" color="var(--color-text-lo)" strokeWidth={1.8} />
            </button>
          </div>

          {/* ════ MONTH NAV ════ */}
          {/* J3 — Month nav skeleton while hydrating */}
          {!isLoaded ? (
            <div className="monthnav-pad" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="skeleton skeleton-circle" style={{ width: 20, height: 20, flexShrink: 0, margin: "12px" }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div className="skeleton skeleton-round" style={{ width: 100, height: 22 }} />
                <div className="skeleton skeleton-round" style={{ width: 60, height: 12 }} />
              </div>
              <div className="skeleton skeleton-circle" style={{ width: 20, height: 20, flexShrink: 0, margin: "12px" }} />
            </div>
          ) : (
          <div className="monthnav-pad" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button aria-label="Previous month" onClick={() => navigateMonth(-1)}
              style={{ background: "none", border: "none", borderRadius: 10, padding: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44 }}>
              <ChevronLeft className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
            </button>

            {/* M1 — Non-interactive flex spacer; M2 — small button on month text only */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "4px 0" }}>
              <AnimatePresence mode="wait" custom={swipeDir}>
                <motion.div key={selectedMonth} custom={swipeDir} variants={slideVariants}
                  initial="enter" animate="center" exit="exit"
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  style={{ textAlign: "center" }}>
                  {/* M2 — Tappable month name: precise target, auto-width only */}
                  <button aria-label="Open month picker" onClick={() => setShowPicker(true)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 8px", borderRadius: 8, display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text-hi)", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)", lineHeight: 1.1 }}>
                      {MONTH_FULL[month - 1]}
                    </div>
                    <ChevronDown size={14} color="var(--color-text-lo)" strokeWidth={2.5} style={{ marginTop: 2, opacity: 0.7 }} />
                  </button>
                  <div style={{ fontSize: 13, color: "var(--color-text-lo)", marginTop: 4, fontWeight: 500, fontFamily: "var(--font-body)" }}>
                    {year}{isCurrentMonth && <span style={{ color: "var(--accent)", fontSize: 11, letterSpacing: "0.08em", marginLeft: 6, fontFamily: "var(--font-body)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3 }}><Circle size={6} fill="var(--accent)" color="var(--accent)" /> NOW</span>}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            <button aria-label="Next month"
              aria-description={isCurrentMonth ? "Cannot navigate past current month" : undefined}
              onClick={() => navigateMonth(1)} disabled={isCurrentMonth}
              style={{
                background: "none", border: "none",
                borderRadius: 10, padding: 12,
                cursor: isCurrentMonth ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                minWidth: 44, minHeight: 44,
                opacity: isCurrentMonth ? 0.25 : 1,
                transition: "opacity 0.2s",
              }}>
              <ChevronRight className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
            </button>
          </div>
          )}{/* end isLoaded month nav */}

          </div>{/* end .sticky-header */}

          {/* ════ SWIPEABLE DASHBOARD — horizontal drag navigates months ════ */}
          <motion.div
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.12}
            onDragEnd={handleDragEnd}
            onClick={() => { openSwipeId && setOpenSwipeId(null); }}
            style={{ touchAction: "pan-y", cursor: "grab" }}>
            <AnimatePresence mode="wait" custom={swipeDir}>
              <motion.div key={selectedMonth} custom={swipeDir} variants={slideVariants}
                initial="enter" animate="center" exit="exit"
                transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}>

                {/* J4+J5 — Shaped skeletons matching real card geometry */}
                {!isLoaded ? (
                  <div className="dash-pad">
                    {/* J4 — SummaryBreakdownCard skeleton */}
                    <div style={{ background: "var(--color-bg-card)", borderRadius: 22, border: "1px solid var(--color-border)", padding: "24px 20px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
                      {/* Total amount block */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <div className="skeleton skeleton-round" style={{ width: 80, height: 10 }} />
                          <div className="skeleton skeleton-round" style={{ width: 140, height: 40 }} />
                          <div className="skeleton skeleton-round" style={{ width: 80, height: 10 }} />
                        </div>
                        <div className="skeleton" style={{ width: 90, height: 36, borderRadius: 10 }} />
                      </div>
                      {/* Progress bar */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <div className="skeleton skeleton-round" style={{ width: 50, height: 10 }} />
                          <div className="skeleton skeleton-round" style={{ width: 70, height: 10 }} />
                        </div>
                        <div className="skeleton" style={{ height: 7, borderRadius: 999 }} />
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <div className="skeleton skeleton-round" style={{ width: 20, height: 10 }} />
                          <div className="skeleton skeleton-round" style={{ width: 30, height: 10 }} />
                        </div>
                      </div>
                      {/* Breakdown rows */}
                      <div style={{ height: 1, background: "var(--color-border)" }} />
                      {[0,1,2].map(i => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div className="skeleton skeleton-circle" style={{ width: 36, height: 36, flexShrink: 0 }} />
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                            <div className="skeleton skeleton-round" style={{ width: `${[60,75,50][i]}%`, height: 12 }} />
                            <div className="skeleton" style={{ height: 4, borderRadius: 999 }} />
                          </div>
                          <div className="skeleton skeleton-round" style={{ width: 50, height: 12 }} />
                        </div>
                      ))}
                    </div>

                    {/* J5 — TransactionList skeleton */}
                    <div style={{ background: "var(--color-bg-card)", borderRadius: 22, border: "1px solid var(--color-border)", padding: "24px 20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
                        <div className="skeleton skeleton-round" style={{ width: 70, height: 11 }} />
                        <div className="skeleton skeleton-round" style={{ width: 50, height: 24, borderRadius: 8 }} />
                      </div>
                      {[0,1,2].map(i => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: i < 2 ? 16 : 0, marginBottom: i < 2 ? 16 : 0, borderBottom: i < 2 ? "1px solid var(--color-border)" : "none" }}>
                          <div className="skeleton skeleton-circle" style={{ width: 40, height: 40, flexShrink: 0 }} />
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                            <div className="skeleton skeleton-round" style={{ width: `${[70,55,80][i]}%`, height: 13 }} />
                            <div className="skeleton skeleton-round" style={{ width: "40%", height: 10 }} />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}>
                            <div className="skeleton skeleton-round" style={{ width: 55, height: 13 }} />
                            <div className="skeleton skeleton-round" style={{ width: 30, height: 10 }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : !hasMonthBudget ? (
                  // S3 — No budget set: show the Initialize Screen gate
                  <div className="dash-pad" style={{ display: "flex", flexDirection: "column" }}>
                    {InitScreen}
                  </div>
                ) : (
                  // § 5  Layout Shifter: mobile = flex column, tablet+ = CSS 2-col grid
                  <div className="dash-pad">
                    {/* Left column: unified Summary + Breakdown card */}
                    <div className="col-left">
                      {SummaryBreakdownCard}
                    </div>
                    {/* Right column: Transactions or Empty state */}
                    <div className="col-right">
                      {hasData ? TransactionList : EmptyState}
                    </div>
                  </div>
                )}

              </motion.div>
            </AnimatePresence>

          {showSwipeHint && hasData && (
          <div className="swipe-hint" style={{ textAlign: "center", marginTop: 14, fontSize: 11, color: "var(--color-text-ghost)", letterSpacing: "0.1em", fontFamily: "var(--font-body)" }}>
            ← SWIPE TO NAVIGATE MONTHS →
          </div>
          )}
          </motion.div>
        </div>{/* end main-scroll */}
        {isLoaded && hasMonthBudget && !fabDisabled && (
        <div className="fab-footer">
          <motion.button
            whileTap={{ scale: 0.94 }}
            whileHover={{ scale: 1.04 }}
            aria-label="Add new expense"
            onClick={() => { setEditTx(null); setShowModal(true); }}
            className="fab-btn"
            style={{
              background: "linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)",
              color: "var(--accent-text)",
              border: "none",
              borderRadius: 16,
              padding: "14px 22px",
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: 8, letterSpacing: "0.03em",
              fontFamily: "var(--font-headline)",
              fontSize: 15, fontWeight: 700,
              animation: "pulseGlow 3s ease-in-out infinite",
              minHeight: 52,
              boxShadow: "0 8px 28px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.16)",
              transition: "background 0.25s, box-shadow 0.25s",
            }}>
            <Plus size={18} color="var(--accent-text)" strokeWidth={3} />
            Add Expense
          </motion.button>
        </div>
        )}{/* end FAB gate */}

        {/* ════ MODALS ════ */}
        <AnimatePresence>

          {/* ── Delete confirmation — action sheet ── */}
          {confirmDeleteTx && (() => {
            const cat = CATEGORIES.find(c => c.id === confirmDeleteTx.category);
            return (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.78)", zIndex: 260, display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "0 12px calc(12px + env(safe-area-inset-bottom))" }}
              onClick={() => { setConfirmDeleteTx(null); setOpenSwipeId(null); }}>

              {/* Card 1 — preview + actions */}
              <motion.div
                initial={{ y: 44, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                exit={{ y: 44, opacity: 0 }}
                transition={{ type: "spring", damping: 30, stiffness: 320 }}
                role="alertdialog" aria-modal="true" aria-label="Confirm delete expense"
                style={{ background: "var(--color-bg-card)", borderRadius: 20, overflow: "hidden", marginBottom: 10, border: "1px solid var(--color-border-mid)" }}
                onClick={(e) => e.stopPropagation()}>

                {/* Item preview */}
                <div style={{ padding: "24px 20px 20px", borderBottom: "0.5px solid var(--color-border)", textAlign: "center" }}>
                  {/* Category icon */}
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 14, background: `${cat?.color}18`, border: `1px solid ${cat?.color}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {cat && <cat.Icon size={22} color={cat.color} strokeWidth={1.8} />}
                    </div>
                  </div>
                  {/* Amount — prominent */}
                  <div style={{ fontSize: 30, fontWeight: 800, color: "var(--color-text-hi)", fontFamily: "var(--font-mono)", marginBottom: 4, letterSpacing: "-0.02em" }}>
                    {fmt(confirmDeleteTx.amountUSD)}
                  </div>
                  {/* Note */}
                  {confirmDeleteTx.note && (
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)", marginBottom: 3 }}>
                      {confirmDeleteTx.note}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", marginBottom: 14 }}>
                    {cat?.label} · {formatDisplayDate(localDateString(new Date(confirmDeleteTx.date)))}
                  </div>
                  {/* Undo callout */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--color-bg-page)", border: "1px solid var(--color-border)", borderRadius: 99, padding: "5px 12px" }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399", flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>You can undo this within 5 seconds</span>
                  </div>
                </div>

                {/* Split action row */}
                <div style={{ display: "flex" }}>
                  <button
                    onClick={() => { setConfirmDeleteTx(null); setOpenSwipeId(null); }}
                    style={{ flex: 1, padding: "17px 0", background: "transparent", border: "none", borderRight: "0.5px solid var(--color-border)", cursor: "pointer", fontSize: 16, fontWeight: 600, color: "var(--color-text-hi)", fontFamily: "var(--font-body)", textAlign: "center" }}>
                    Cancel
                  </button>
                  <button
                    onClick={() => handleDelete(confirmDeleteTx.id)}
                    style={{ flex: 1, padding: "17px 0", background: "transparent", border: "none", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "#ef4444", fontFamily: "var(--font-body)", textAlign: "center" }}>
                    Delete
                  </button>
                </div>
            </motion.div>
            </motion.div>
            );
          })()}

          {showPicker && (
            <MonthPicker current={selectedMonth}
              onSelect={(k) => {
                const { year: ny, month: nm } = parseMonthKey(k);
                const { year: cy, month: cm } = parseMonthKey(selectedMonth);
                setSwipeDir(ny > cy || (ny === cy && nm > cm) ? 1 : -1);
                setSelectedMonth(k);
                setFilterCategory("all");
                setShowFilterMenu(false);
              }}
              onClose={() => setShowPicker(false)}
            />
          )}

          {showModal && (
            <EntryModal
              tx={editTx}
              selectedMonth={selectedMonth}
              monthBalance={monthBalance}
              totalUSD={totalUSD}
              constraintMode={constraintMode}
              onSave={handleSave}
              onDelete={handleDelete}
              onRequestDelete={(t) => { setShowModal(false); setEditTx(null); setConfirmDeleteTx(t); }}
              onClose={() => { setShowModal(false); setEditTx(null); }}
            />
          )}

          {/* ── Set Budget Modal — O3 ── */}
          {showBudgetModal && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="modal-backdrop"
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.92)", zIndex: 250, display: "flex" }}
              onClick={() => setShowBudgetModal(false)}>
              <motion.div ref={budgetModalRef}
                initial={pageModalMode === "center" ? MODAL_ENTER_CENTER : MODAL_ENTER_SHEET}
                animate={pageModalMode === "center" ? MODAL_ANIM_CENTER  : MODAL_ANIM_SHEET}
                exit={pageModalMode   === "center" ? MODAL_EXIT_CENTER   : MODAL_EXIT_SHEET}
                transition={{ type: "spring", damping: 28, stiffness: 300 }}
                className="modal-sheet"
                role="dialog" aria-modal="true" aria-label={monthBalance > 0 ? "Update Monthly Budget" : "Set Monthly Budget"}
                style={{ background: "var(--color-bg-card)", padding: "28px 28px 56px", width: "100%", border: "1px solid var(--color-border-mid)", maxWidth: 480, margin: "0 auto" }}
                onClick={(e) => e.stopPropagation()}>

                {pageModalMode === "sheet" && <div style={{ width: 40, height: 4, background: "var(--color-border-mid)", borderRadius: 2, margin: "0 auto 24px" }} />}

                {/* A2 — Dynamic header: Set vs Update */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 22, fontWeight: 600, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", letterSpacing: "-0.01em" }}>
                    {monthBalance > 0 ? "Update Budget" : "Set Monthly Budget"}
                  </span>
                  <button onClick={() => setShowBudgetModal(false)}
                    style={{ background: "var(--color-bg-nav)", border: "none", borderRadius: 9, padding: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, minHeight: 36 }}>
                    <X className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
                  </button>
                </div>
                {/* A2/A4 — Flexible copy: no lock language */}
                <div style={{ fontSize: 12, color: "var(--color-text-lo)", marginBottom: 24, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                  {MONTH_FULL[month - 1]} {year}
                  {monthBalance > 0 && <span style={{ color: "var(--color-text-lo)" }}> · Current: ${monthBalance.toFixed(2)}</span>}
                </div>

                {/* Amount input */}
                <div style={{ position: "relative", marginBottom: 16 }}>
                  <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 22, color: "var(--accent)", fontWeight: 700, fontFamily: "var(--font-headline)", pointerEvents: "none", zIndex: 1 }}>$</span>
                  <input
                    ref={budgetInputRef}
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(sanitizeNum(e.target.value))}
                    onKeyDown={(e) => e.key === "Enter" && handleSetBudget()}
                    placeholder="0.00"
                    onFocus={(e) => { const len = e.target.value.length; e.target.setSelectionRange(len, len); }}
                    className="input-field"
                    style={{
                      width: "100%", boxSizing: "border-box",
                      borderRadius: 12, padding: "16px 16px 16px 50px",
                      fontSize: 32, fontWeight: 800,
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                </div>

                {/* KHR preview */}
                {budgetInput && parseFloat(budgetInput) > 0 && (
                  <div style={{ fontSize: 12, color: "#34d399", fontWeight: 600, fontFamily: "var(--font-body)", marginBottom: 16, paddingLeft: 4 }}>
                    ≈ {Math.round(parseFloat(budgetInput) * EXCHANGE_RATE).toLocaleString()} ៛
                  </div>
                )}

                {/* A2 — Flexible info note replaces immutability warning */}
                <div style={{ background: "var(--accent-muted)", border: "1px solid var(--accent-border)", borderRadius: 12, padding: "10px 14px", marginBottom: 24, display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <Lightbulb size={14} color="var(--accent)" strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                    You can update your budget at any time — changes apply immediately.
                  </span>
                </div>

                {/* Confirm button — MO4: nudge animation instead of silent disabled state */}
                <button
                  className={`btn-primary${budgetShake ? " btn-nudge" : ""}`}
                  onClick={() => {
                    if (!budgetInput || parseFloat(budgetInput) <= 0) {
                      setBudgetShake(true);
                      setTimeout(() => setBudgetShake(false), 400);
                      return;
                    }
                    handleSetBudget();
                  }}
                  aria-disabled={!budgetInput || parseFloat(budgetInput) <= 0}
                  style={{
                    width: "100%", padding: "15px", fontSize: 16,
                    fontFamily: "var(--font-headline)",
                    ...(!budgetInput || parseFloat(budgetInput) <= 0 ? {
                      background: "var(--color-bg-nav)",
                      color: "var(--color-text-lo)",
                      border: "1px solid var(--color-border-mid)",
                      opacity: 0.6,
                    } : {}),
                  }}>
                  {monthBalance > 0 ? "Update Budget" : "Confirm Budget"}
                </button>
              </motion.div>
            </motion.div>
          )}

          {/* ── Settings sheet ── */}
          {showSettings && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="modal-backdrop"
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.88)", zIndex: 200, display: "flex" }}
              onClick={() => { setShowSettings(false); setResetConfirm(false); }}>
              <motion.div ref={settingsModalRef}
                initial={pageModalMode === "center" ? MODAL_ENTER_CENTER : MODAL_ENTER_SHEET}
                animate={pageModalMode === "center" ? MODAL_ANIM_CENTER  : MODAL_ANIM_SHEET}
                exit={pageModalMode   === "center" ? MODAL_EXIT_CENTER   : MODAL_EXIT_SHEET}
                transition={{ type: "spring", damping: 28, stiffness: 280 }}
                className="modal-sheet"
                role="dialog" aria-modal="true" aria-label="Settings"
                style={{ background: "var(--color-bg-card)", padding: "24px 20px 48px", width: "100%", border: "1px solid var(--color-border)", maxWidth: 480, margin: "0 auto" }}
                onClick={(e) => e.stopPropagation()}>

                {/* Drag handle */}
                {pageModalMode === "sheet" && <div style={{ width: 36, height: 4, background: "var(--color-border-mid)", borderRadius: 2, margin: "0 auto 20px" }} />}

                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", letterSpacing: "-0.01em" }}>Settings</span>
                  <button aria-label="Close settings"
                    onClick={() => { setShowSettings(false); setResetConfirm(false); }}
                    style={{ background: "var(--color-bg-nav)", border: "none", borderRadius: 9, padding: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <X size={16} color="var(--color-text-lo)" strokeWidth={2} />
                  </button>
                </div>

                {/* ── Group 1: Appearance ── */}
                <div style={{ background: "var(--color-bg-page)", borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>

                  {/* Theme row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", borderBottom: "0.5px solid var(--color-border)" }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>Theme</span>
                    <div role="radiogroup" aria-label="Theme mode" style={{ display: "flex", background: "var(--color-bg-nav)", borderRadius: 8, padding: 2, gap: 2 }}>
                      {(["system", "dark", "light"] as const).map((m) => (
                        <button key={m} role="radio" aria-checked={themeMode === m} onClick={() => setThemeMode(m)}
                          style={{ padding: "5px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: themeMode === m ? "var(--accent)" : "transparent", color: themeMode === m ? "var(--accent-text)" : "var(--color-text-lo)", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-body)", textTransform: "capitalize", transition: "all 0.15s" }}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Accent row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", borderBottom: "0.5px solid var(--color-border)" }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>Accent</span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {([
                        { id: "yellow",  hex: "#fbbf24" },
                        { id: "indigo",  hex: "#818cf8" },
                        { id: "emerald", hex: "#34d399" },
                        { id: "rose",    hex: "#fb7185" },
                      ] as const).map(({ id, hex }) => (
                        <button key={id} aria-label={`${id} palette`} onClick={() => setPalette(id)}
                          style={{ width: 22, height: 22, borderRadius: "50%", background: hex, border: "none", cursor: "pointer", boxShadow: palette === id ? `0 0 0 2px var(--color-bg-card), 0 0 0 3.5px ${hex}` : "none", transition: "box-shadow 0.15s" }} />
                      ))}
                    </div>
                  </div>

                  {/* Budget Mode row */}
                  <div style={{ padding: "13px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: constraintMode ? 6 : 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>Budget mode</span>
                      <div role="radiogroup" aria-label="Budget mode" style={{ display: "flex", background: "var(--color-bg-nav)", borderRadius: 8, padding: 2, gap: 2 }}>
                        {(["soft", "hard"] as const).map((m) => (
                          <button key={m} role="radio" aria-checked={constraintMode === m} onClick={() => setConstraintMode(m)}
                            style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: constraintMode === m ? "var(--accent)" : "transparent", color: constraintMode === m ? "var(--accent-text)" : "var(--color-text-lo)", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-body)", textTransform: "capitalize", transition: "all 0.15s" }}>
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                      {constraintMode === "soft" ? "Allows over-budget entries with a warning." : "Requires confirmation before exceeding your budget."}
                    </div>
                  </div>
                </div>

                {/* ── Group 2: Notifications ── */}
                {notifPermission !== "unsupported" && (
                  <div style={{ background: "var(--color-bg-page)", borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px" }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-mid)", fontFamily: "var(--font-body)", marginBottom: 2 }}>Budget alerts</div>
                        <div style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>
                          {notifPermission === "granted" && <><Check size={11} color="#34d399" strokeWidth={2.5} style={{ display: "inline", verticalAlign: "middle", marginRight: 3 }} />At 80% and 95% of budget</>}
                          {notifPermission === "denied"  && "Blocked — enable in browser settings"}
                          {notifPermission === "default" && "Get notified when nearing your limit"}
                        </div>
                      </div>
                      {notifPermission === "default" && (
                        <button onClick={requestNotifPermission}
                          style={{ background: "var(--accent-muted)", border: "1px solid var(--accent-border)", color: "var(--accent)", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-body)", cursor: "pointer", whiteSpace: "nowrap" }}>
                          Enable
                        </button>
                      )}
                      {notifPermission === "granted" && (
                        <span style={{ fontSize: 11, background: "#34d39920", color: "#34d399", border: "1px solid #34d39940", padding: "3px 9px", borderRadius: 99, fontFamily: "var(--font-body)", fontWeight: 500 }}>Active</span>
                      )}
                      {notifPermission === "denied" && (
                        <span style={{ fontSize: 11, background: "#ef444418", color: "#ef4444", border: "1px solid #ef444440", padding: "3px 9px", borderRadius: 99, fontFamily: "var(--font-body)", fontWeight: 500 }}>Blocked</span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Group 4: Data — shown when month has a budget or entries ── */}
                {(monthTxs.length > 0 || monthBalance > 0) && (
                  <div style={{ background: "var(--color-bg-page)", borderRadius: 14, overflow: "hidden" }}>
                    {!resetConfirm ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px" }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", marginBottom: 2 }}>
                            Reset {MONTH_FULL[month - 1]}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", opacity: 0.7 }}>
                            Clears {monthTxs.length > 0 ? `${monthTxs.length} ${monthTxs.length === 1 ? "entry" : "entries"} and ` : ""}the budget
                          </div>
                        </div>
                        <button onClick={() => setResetConfirm(true)}
                          style={{ background: "#ef444418", border: "1px solid #ef444440", color: "#ef4444", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-body)", whiteSpace: "nowrap" }}>
                          Reset
                        </button>
                      </div>
                    ) : (
                      <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ fontSize: 12, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.5, flex: 1, paddingRight: 12 }}>
                          Removes all {MONTH_FULL[month - 1]} entries and resets the budget. Cannot be undone.
                        </div>
                        <button onClick={handleResetMonth}
                          style={{ background: "#ef4444", border: "none", color: "#fff", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-body)", whiteSpace: "nowrap", flexShrink: 0 }}>
                          Confirm
                        </button>
                      </div>
                    )}
                  </div>
                )}

              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {toast && (
            <motion.div key={toast.msg}
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              initial={{ opacity: 0, y: 12, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: 8, x: "-50%" }}
              transition={{ duration: 0.22 }}
              style={{
                position: "fixed", bottom: 100, left: "50%", zIndex: 400,
                background: toast.type === "warn" ? "var(--toast-warn-bg)" : toast.type === "success" ? "var(--toast-ok-bg)" : "var(--toast-info-bg)",
                border: "1px solid",
                borderColor: toast.type === "warn" ? "var(--toast-warn-border)" : toast.type === "success" ? "var(--toast-ok-border)" : "var(--toast-info-border)",
                borderRadius: 14,
                width: "fit-content",
                maxWidth: "calc(100vw - 48px)",
                boxShadow: "var(--toast-shadow)",
              }}>
              {/* Content row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: toast.undoFn ? "10px 8px 10px 14px" : "10px 16px" }}>
                <span style={{
                  flex: 1, fontSize: 13, fontWeight: 500,
                  color: toast.type === "warn" ? "var(--toast-warn-text)" : toast.type === "success" ? "var(--toast-ok-text)" : "var(--toast-info-text)",
                  fontFamily: "var(--font-body)", lineHeight: 1.4,
                  whiteSpace: "nowrap",
                }}>
                  {toast.msg}
                </span>
                {toast.undoFn && (
                  <button
                    onClick={() => { toast.undoFn?.(); setToast(null); }}
                    style={{
                      flexShrink: 0,
                      background: toast.type === "warn" ? "var(--toast-warn-border)" : toast.type === "success" ? "var(--toast-ok-border)" : "var(--toast-info-border)",
                      border: "none", borderRadius: 8,
                      padding: "6px 14px", cursor: "pointer",
                      fontSize: 12, fontWeight: 700,
                      color: "#fff",
                      fontFamily: "var(--font-body)", letterSpacing: "0.02em",
                    }}>
                    Undo
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </main>
    </>
  );
}
