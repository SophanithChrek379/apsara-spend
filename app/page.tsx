"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence, PanInfo } from "framer-motion";
import {
  Settings, ChevronLeft, ChevronRight, ChevronDown, X, Trash2, Plus,
  UtensilsCrossed, Bike, Zap, Users, ShoppingBag, MoreHorizontal,
  CalendarDays,
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
  const stripped = s.replace(/[^0-9.]/g, "");
  const m = stripped.match(/^(\d{0,4})(\.?)(\d{0,2}).*$/);
  return m ? m[1] + m[2] + m[3] : "";
};

// KHR display formatter — converts raw digit string to comma-separated thousands
// e.g. "50000" → "50,000"  |  "4000000" → "4,000,000"
// The underlying rawAmount always stays as plain digits for computation.
const formatKHRDisplay = (raw: string): string => {
  if (!raw) return "";
  const n = parseInt(raw, 10);
  return isNaN(n) ? "" : n.toLocaleString("en-US");
};

// § 2  KHR sanitiser — integers only (no decimals for physical currency)
const sanitizeKHR = (s: string) => s.replace(/[^0-9]/g, "");

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
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: "var(--font-body)", fontWeight: 600 }}>
          Budget
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {total > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-lo)", fontFamily: "var(--font-mono)" }}>
              {pctDisplay}%
            </span>
          )}
          <span style={{ fontSize: 11, fontWeight: 700, color: tierColor, transition: "color 0.3s", fontFamily: "var(--font-body)" }}>
            {tierLabel}
          </span>
        </div>
      </div>
      <div style={{ background: "var(--color-bg-input)", borderRadius: 999, height: 7, overflow: "hidden" }}>
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          style={{ height: "100%", background: tierColor, borderRadius: 999,
            boxShadow: tier >= 3 ? `0 0 10px ${tierColor}80` : "none",
            animation: tier >= 3 ? "budgetPulse 1.6s ease-in-out infinite" : "none",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>$0</span>
        {/* F1 / A3 — edit budget: prominent CTA when over budget, subtle pencil otherwise */}
        {isOver ? (
          <button onClick={onEditBudget}
            style={{ background: "#ef444415", border: "1px solid #ef444430", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "3px 8px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#ef4444", fontFamily: "var(--font-body)" }}>Adjust budget ›</span>
          </button>
        ) : (
          <button onClick={onEditBudget}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", borderRadius: 6 }}>
            <span style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>${monthBudget.toFixed(0)}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M7 1.5l1.5 1.5L3 8.5H1.5V7L7 1.5z" stroke="var(--color-text-lo)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
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
        style={{ background: "var(--color-bg-nav)", borderRadius: 24, padding: "28px 28px", border: "1px solid var(--color-border-mid)", width: "100%", maxWidth: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button aria-label="Previous year" onClick={() => setPickerYear((y) => y - 1)}
            style={{ background: "var(--color-bg-nav)", border: "none", borderRadius: 10, padding: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
          </button>
          <span style={{ fontSize: 20, fontWeight: 600, color: "var(--color-text-hi)", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)" }}>{pickerYear}</span>
          <button aria-label="Next year" onClick={() => setPickerYear((y) => y + 1)} disabled={atMax}
            style={{
              background: "var(--color-bg-nav)", border: "none", borderRadius: 10, padding: 10,
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
                  // Future months: opacity-based disable — clear on both dark and light themes
                  // Past/present months: full text-mid color — readable on both themes
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

// ─── EntryModal ───────────────────────────────────────────────────────────────

function EntryModal({ tx, selectedMonth, monthBalance, totalUSD: currentTotal, constraintMode, onSave, onDelete, onClose }: {
  tx: Transaction | null; selectedMonth: string;
  monthBalance: number;
  totalUSD: number;
  constraintMode: "soft" | "hard"; // C1 — controls whether over-budget is blocked or warned
  onSave: (t: Transaction) => void; onDelete?: (id: string) => void; onClose: () => void;
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
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [shake,         setShake]         = useState(false);
  // § 2  KHR denomination hint state — shown when amount is not a multiple of KHR_STEP
  const [khrHint,       setKhrHint]       = useState(false);
  const amountRef    = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const modalRef     = useRef<HTMLDivElement>(null);

  useEffect(() => { setTimeout(() => amountRef.current?.focus(), 120); }, []);
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
    const digits = val.replace(/[^0-9]/g, "").slice(0, 8);
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
  const borderColor = shake ? "#ef4444" : khrHint ? "#f59e0b" : parsedAmt > 0 ? "var(--accent-border)" : "var(--color-border)";

  // Adaptive font size — shrinks as the display value gets longer to prevent overflow
  const displayVal = currency === "KHR" ? formatKHRDisplay(rawAmount) : rawAmount;
  const amountFontSize = displayVal.length <= 7 ? 32 : displayVal.length <= 10 ? 26 : 22;

  // P1 — Over-limit guard: only active when a budget is set and this is a new entry.
  // For edits we skip the check (editing can only reduce spend or stay neutral).
  const wouldExceed = !tx && monthBalance > 0 && previewUSD > 0
    && pin2(currentTotal + previewUSD) > monthBalance;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.9)", zIndex: 200, display: "flex", alignItems: "flex-end" }}
      onClick={onClose}
    >
      <motion.div
        ref={modalRef}
        initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        style={{ background: "var(--color-bg-card)", borderRadius: "24px 24px 0 0", padding: "28px 28px 44px", width: "100%", border: "1px solid var(--color-border-mid)", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ width: 40, height: 4, background: "var(--color-border-mid)", borderRadius: 2, margin: "0 auto 24px" }} />

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
        <div style={{ display: "flex", background: "var(--color-bg-input)", borderRadius: 12, padding: 4, marginBottom: 16, gap: 4 }}>
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
            value={currency === "KHR" ? formatKHRDisplay(rawAmount) : rawAmount}
            onChange={(e) =>
              currency === "KHR"
                ? handleKHRChange(e.target.value)
                : setRawAmount(sanitizeNum(e.target.value))
            }
            onBlur={handleAmountBlur}
            onWheel={(e) => e.currentTarget.blur()}
            placeholder={currency === "USD" ? "0.00" : "0"}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "var(--color-bg-input)", border: `2px solid ${borderColor}`,
              borderRadius: 14,
              padding: rawAmount ? "16px 44px 16px 50px" : "16px 16px 16px 50px",
              fontSize: amountFontSize, fontWeight: 800, color: "var(--color-text-hi)", outline: "none",
              fontFamily: "var(--font-mono)",
              transition: "border-color 0.2s, font-size 0.12s ease",
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
            <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1.2 }}>⚠️</span>
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
          placeholder="Note (optional, max 100 chars)..."
          maxLength={100}
          className="focus-input"
          style={{ width: "100%", boxSizing: "border-box", background: "var(--color-bg-input)", border: "1.5px solid var(--color-border)", borderRadius: 12, padding: "12px 16px", fontSize: 16, fontFamily: "var(--font-body)", lineHeight: 1.5, color: "var(--color-text-hi)", outline: "none", marginBottom: 16 }}
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
            style={{
              display: "flex", alignItems: "center",
              background: "var(--color-bg-input)",
              border: "1.5px solid var(--color-border)",
              borderRadius: 12,
              padding: "14px 16px",
              minHeight: 48,
              pointerEvents: "none",
              userSelect: "none",
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

        {/* Category picker */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 16 }}>
          {CATEGORIES.map((c) => {
            const active = cat === c.id;
            return (
              <button key={c.id} onClick={() => setCat(c.id)} aria-label={c.label} title={c.label}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "10px 2px 8px", borderRadius: 12, gap: 4,
                  border:     active ? `2px solid ${c.color}` : "2px solid transparent",
                  background: active ? `${c.color}18` : "var(--color-bg-input)",
                  cursor: "pointer", transition: "all 0.15s", minHeight: 60,
                }}>
                <c.Icon className="icon-cat" color={active ? c.color : "var(--color-text-lo)"} strokeWidth={1.8} />
                <span style={{ fontSize: 10, color: active ? c.color : "var(--color-text-lo)", fontWeight: 700, fontFamily: "var(--font-body)", letterSpacing: "0.05em" }}>
                  {c.label.toUpperCase()}
                </span>
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8 }}>
          {isEdit && !deleteConfirm && (
            <button aria-label="Delete expense" onClick={() => setDeleteConfirm(true)}
              style={{ padding: 14, borderRadius: 14, border: "1px solid #ef444440", background: "#ef444412", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 48 }}>
              <Trash2 size={16} color="#ef4444" strokeWidth={2} />
            </button>
          )}
          {deleteConfirm && (
            <button onClick={() => { onDelete?.(tx!.id); onClose(); }}
              style={{ flex: 1, padding: 14, borderRadius: 14, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-body)" }}>
              Confirm delete
            </button>
          )}
          {!deleteConfirm && (
            <button onClick={handleSave}
              style={{
                flex: 1, padding: 14, borderRadius: 14,
                background: wouldExceed && constraintMode === "soft"
                  ? "linear-gradient(135deg, #ef4444, #dc2626)"
                  : wouldExceed && constraintMode === "hard"
                  ? "transparent"
                  : "linear-gradient(135deg, var(--accent), var(--accent-dim))",
                border: wouldExceed && constraintMode === "hard" ? "1.5px solid #f59e0b60" : "none",
                color: wouldExceed && constraintMode === "hard" ? "#f59e0b" : "var(--accent-text)",
                fontWeight: 700, fontSize: 16, fontFamily: "var(--font-body)",
                cursor: "pointer",
                boxShadow: wouldExceed ? "none" : "0 3px 16px var(--accent-glow)",
                transition: "all 0.2s",
              }}>
              {wouldExceed && constraintMode === "hard"
                ? "Over budget — confirm?"
                : isEdit ? "Save Changes" : "Add Expense"}
            </button>
          )}
          {deleteConfirm && (
            <button onClick={() => setDeleteConfirm(false)}
              style={{ padding: "14px 16px", borderRadius: 14, border: "1px solid var(--color-border-mid)", background: "var(--color-bg-nav)", color: "var(--color-text-lo)", cursor: "pointer", fontSize: 14, fontFamily: "var(--font-body)" }}>
              Cancel
            </button>
          )}
        </div>
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
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
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
                <button onClick={() => setShowHardConfirm(false)}
                  style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "1px solid var(--color-border-mid)", background: "var(--color-bg-nav)", color: "var(--color-text-lo)", fontSize: 14, fontWeight: 600, fontFamily: "var(--font-body)", cursor: "pointer" }}>
                  Cancel
                </button>
                <button onClick={() => { setShowHardConfirm(false); commitSave(); }}
                  style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "none", background: "#ef4444", color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: "var(--font-body)", cursor: "pointer" }}>
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
  const [data,             setData]             = useState<AppData>(defaultData);
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
  // O2 — monthly budget flow state
  const [showBudgetModal,  setShowBudgetModal]  = useState(false);
  const [budgetInput,      setBudgetInput]      = useState("");
  // A2 — focus trap refs
  const budgetModalRef   = useRef<HTMLDivElement>(null);
  const settingsModalRef = useRef<HTMLDivElement>(null);

  // A2 — activate focus trap whenever these modals are open
  useFocusTrap(budgetModalRef,   showBudgetModal);
  useFocusTrap(settingsModalRef, showSettings);
  // Q3 — theme mode: dark (default) | light | system
  const [themeMode,        setThemeMode]        = useState<"dark"|"light"|"system">("dark");
  // Q4 — colour palette: yellow (default) | indigo | emerald | rose
  const [palette,          setPalette]          = useState<"yellow"|"indigo"|"emerald"|"rose">("yellow");
  // C1 — constraint mode: soft (allow over-budget) | hard (confirm modal)
  const [constraintMode,   setConstraintMode]   = useState<"soft"|"hard">("soft");
  // E1 — notification permission: "default" | "granted" | "denied" | "unsupported"
  const [notifPermission,  setNotifPermission]  = useState<"default"|"granted"|"denied"|"unsupported">("default");
  // B2 — track which tier alerts have already fired this session to avoid repeats
  const firedTiers = useRef<Set<number>>(new Set());

  const showToast = useCallback((msg: string, type: Toast["type"] = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
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
        showToast("Budget alerts enabled!", "success");
        // E2 — Test notification so user knows it works
        new Notification("Apsara Spend", {
          body: "Budget alerts are now active. You'll be notified at 80% and 95%.",
          icon: "/icon-192.png",
        });
      } else {
        showToast("Notifications blocked. Enable them in browser settings.", "warn");
      }
    } catch {
      showToast("Could not request notification permission.", "warn");
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
    CATEGORIES.map((c) => ({
      ...c,
      total: pin2(monthTxs.filter((t) => t.category === c.id).reduce((s, t) => s + t.amountUSD, 0)),
    })).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
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

  // B2 / E2 — Fire toast + browser notification once per tier crossing per month
  useEffect(() => {
    if (monthBalance <= 0 || totalUSD <= 0) return;
    const pct  = (totalUSD / monthBalance) * 100;
    const tier = totalUSD > monthBalance ? 4 : pct >= 95 ? 3 : pct >= 80 ? 2 : pct >= 50 ? 1 : 0;
    if (tier > 0 && !firedTiers.current.has(tier)) {
      firedTiers.current.add(tier);
      const msgs: Record<number,string> = {
        1: "You've used 50% of your budget.",
        2: "80% of your budget used — nearing limit.",
        3: "95% reached — almost at your limit!",
        4: `Over budget by $${pin2(totalUSD - monthBalance).toFixed(2)}.`,
      };
      showToast(msgs[tier], tier >= 3 ? "warn" : "info");
      // E2 — Fire browser notification for tier 2+ (≥80%) when permission granted.
      // Tier 1 (50%) is informational only — not intrusive enough to notify.
      if (tier >= 2 && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        new Notification("Apsara Spend — Budget Alert", {
          body: msgs[tier],
          icon: "/icon-192.png",
          tag: `budget-tier-${tier}`,   // prevents duplicate banners if already shown
          silent: tier < 3,             // only sound/vibrate at critical tiers (≥95%)
        });
      }
    }
  }, [totalUSD, monthBalance, showToast]);

  // Reset fired tiers on month switch so alerts re-arm for new month
  useEffect(() => { firedTiers.current = new Set(); }, [selectedMonth]);

  // ── Navigation ───────────────────────────────────────────────────────────────

  const navigateMonth = (delta: 1 | -1) => {
    const next = shiftMonth(selectedMonth, delta);
    if (delta === 1 && next > todayMonthKey()) {
      showToast("Can't navigate to a future month.", "info");
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
    showToast(wasEdit ? "Expense updated." : "Expense added!", "success");
  };

  const handleDelete = (id: string) => {
    setShowModal(false);
    setEditTx(null);
    setData((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) }));
    showToast("Expense deleted.", "warn");
  };

  const handleResetMonth = () => {
    setData((d) => ({
      ...d,
      transactions: d.transactions.filter((t) => {
        const dt = new Date(t.date);
        return toMonthKey(dt.getFullYear(), dt.getMonth() + 1) !== selectedMonth;
      }),
    }));
    setResetConfirm(false);
    setShowSettings(false);
    showToast(`${MONTH_FULL[month - 1]} ${year} data cleared.`, "warn");
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
    if (amount <= 0) { showToast("Please enter a valid budget amount.", "info"); return; }
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
      <div style={{ padding: "28px 28px 22px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>
              Total Spent
            </div>
            <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--color-text-hi)", lineHeight: 1, fontFamily: "var(--font-headline)" }}>
              {currency === "KHR"
                ? `${Math.round(totalUSD * EXCHANGE_RATE).toLocaleString()} ៛`
                : `$${totalUSD.toFixed(2)}`}
            </div>
            {/* N3 — period label */}
            <div style={{ fontSize: 11, color: "var(--color-text-lo)", marginTop: 6, fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}>
              {MONTH_FULL[month - 1]} {year}
            </div>

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
          onEditBudget={() => { setBudgetInput(String(monthBalance)); setShowBudgetModal(true); }}
        />
      </div>

      {/* ── Hairline divider + Breakdown section (only when there is data) ── */}
      {hasBreakdown && (
        <>
          <div style={{ height: 1, background: "#1a2333", margin: "0 24px" }} />
          <div style={{ padding: "22px 28px 28px" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 16, fontFamily: "var(--font-body)", fontWeight: 600 }}>
              Breakdown
            </div>
            {categoryTotals.filter((c) => c.total > 0).map((c, i) => {
              const pct = totalUSD > 0 ? (c.total / totalUSD) * 100 : 0;
              return (
                <motion.div key={c.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, duration: 0.2 }}
                  whileHover={{ backgroundColor: `${c.color}0a` }}
                  style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: i < categoryTotals.filter(x => x.total > 0).length - 1 ? 12 : 0, borderRadius: 10, padding: "4px 4px", marginLeft: -4, marginRight: -4 }}>
                  <CategoryIcon cat={c} active />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>{c.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c.color, fontFamily: "var(--font-mono)" }}>{fmt(c.total)}</span>
                    </div>
                    <div style={{ background: "var(--color-bg-page)", borderRadius: 999, height: 4, overflow: "hidden" }}>
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
    <div style={{ textAlign: "center", padding: "56px 28px", background: "var(--color-bg-card)", borderRadius: 22, border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>

      {/* Inline SVG — undraw-style empty wallet illustration              */}
      {/* Colours: amber #fbbf24, slate body #1e2a38, surface #141920      */}
      <svg
        width="120" height="80"
        viewBox="0 0 120 80"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ marginBottom: 16 }}
      >
        {/* Wallet body */}
        <rect x="8" y="28" width="88" height="44" rx="8" fill="#1e2a38" />
        {/* Wallet flap */}
        <path d="M8 36 Q8 28 16 28 H80 Q88 28 88 36 V44 H8 Z" fill="var(--color-bg-nav)" />
        {/* Flap fold line */}
        <line x1="8" y1="44" x2="88" y2="44" stroke="#2d3f55" strokeWidth="1" />
        {/* Card slot inside wallet */}
        <rect x="16" y="50" width="40" height="14" rx="3" fill="var(--color-bg-nav)" stroke="#2d3f55" strokeWidth="1" />
        {/* Card shine */}
        <rect x="20" y="54" width="12" height="2" rx="1" fill="#2d3f55" />
        {/* Amber coin — hovering above wallet, signalling emptiness */}
        <circle cx="90" cy="22" r="14" fill="#fbbf2420" stroke="var(--accent)" strokeWidth="1.5" />
        {/* Dollar sign in coin */}
        <text x="90" y="27" textAnchor="middle" fill="var(--accent)" fontSize="12" fontWeight="700" fontFamily="system-ui">$</text>
        {/* Small sparkle dots — top right */}
        <circle cx="108" cy="10" r="2" fill="var(--accent-border)" />
        <circle cx="114" cy="18" r="1.5" fill="var(--accent-border)" />
        <circle cx="104" cy="4"  r="1"   fill="var(--accent-border)" />
        {/* Dashed lines inside wallet — indicating no bills */}
        <line x1="62" y1="54" x2="78" y2="54" stroke="#2d3f55" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
        <line x1="62" y1="58" x2="74" y2="58" stroke="#2d3f55" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
      </svg>

      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.4 }}>No expenses yet for {MONTH_FULL[month - 1]}</div>
      <div style={{ fontSize: 12, marginTop: 6, color: "var(--color-text-ghost)", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>Tap + Add Expense to get started</div>
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
    <div style={{ background: "var(--color-bg-card)", borderRadius: 22, padding: "28px 28px", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column" }}>

      {/* ── Header row: count label + category filter dropdown ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: "var(--font-body)", fontWeight: 600 }}>
          {filterCategory === "all"
            ? `${monthTxs.length} ${monthTxs.length === 1 ? "entry" : "entries"}`
            : `${filteredTxs.length} of ${monthTxs.length}`}
        </div>

        {/* ── Filter button ── */}
        <div style={{ position: "relative" }}>
          <button
            aria-label="Filter by category"
            onClick={() => setShowFilterMenu((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: filterCategory !== "all" ? `${activeCat?.color}18` : "var(--color-bg-nav)",
              border: filterCategory !== "all" ? `1px solid ${activeCat?.color}40` : "1px solid var(--color-border-mid)",
              borderRadius: 8, padding: "5px 10px",
              cursor: "pointer", transition: "all 0.15s",
            }}
          >
            {filterCategory !== "all" && activeCat && (
              <activeCat.Icon
                size={12}
                color={activeCat.color}
                strokeWidth={2}
              />
            )}
            <span style={{ fontSize: 11, fontWeight: 600, color: filterCategory !== "all" ? activeCat?.color : "var(--color-text-lo)", fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}>
              {filterCategory === "all" ? "All" : activeCat?.label}
            </span>
            <ChevronDown
              size={11}
              color={filterCategory !== "all" ? activeCat?.color : "var(--color-text-lo)"}
              strokeWidth={2.5}
              style={{ transition: "transform 0.15s", transform: showFilterMenu ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>

          {/* ── Dropdown overlay ── */}
          <AnimatePresence>
            {showFilterMenu && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
                style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  background: "var(--color-bg-nav)", border: "1px solid var(--color-border-mid)",
                  borderRadius: 12, padding: "6px", zIndex: 100,
                  minWidth: 148, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                }}
              >
                {/* All option */}
                <button
                  onClick={() => { setFilterCategory("all"); setShowFilterMenu(false); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 8, border: "none",
                    background: filterCategory === "all" ? "var(--color-border)" : "transparent",
                    cursor: "pointer", transition: "background 0.12s",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: filterCategory === "all" ? 600 : 400, color: "var(--color-text-hi)", fontFamily: "var(--font-body)" }}>
                    All categories
                  </span>
                </button>

                {/* Divider */}
                <div style={{ height: 1, background: "var(--color-border-mid)", margin: "4px 0" }} />

                {/* Category options — only show categories that have entries */}
                {CATEGORIES.filter((c) => monthTxs.some((t) => t.category === c.id)).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setFilterCategory(c.id); setShowFilterMenu(false); }}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 10px", borderRadius: 8, border: "none",
                      background: filterCategory === c.id ? `${c.color}18` : "transparent",
                      cursor: "pointer", transition: "background 0.12s",
                    }}
                  >
                    <c.Icon size={14} color={c.color} strokeWidth={1.8} />
                    <span style={{ fontSize: 13, fontWeight: filterCategory === c.id ? 600 : 400, color: filterCategory === c.id ? c.color : "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>
                      {c.label}
                    </span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Transaction rows (filtered) ── */}
      {filteredTxs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px 0", color: "var(--color-text-lo)", fontSize: 13, fontFamily: "var(--font-body)" }}>
          No {activeCat?.label} entries this month
        </div>
      ) : (
        filteredTxs
          .sort((a, b) =>
            new Date(b.date).getTime() - new Date(a.date).getTime() ||
            b.id.localeCompare(a.id)
          )
          .map((tx, i) => {
            const cat     = CATEGORIES.find((c) => c.id === tx.category) ?? CATEGORIES[5];
            const dateStr = formatDisplayDate(localDateString(new Date(tx.date)));
            return (
              <motion.button
                key={tx.id}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
                onClick={() => { setEditTx(tx); setShowModal(true); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 0",
                  borderBottom: i < filteredTxs.length - 1 ? "1px solid #0f1520" : "none",
                  background: "none", border: "none",
                  borderBottomWidth: i < filteredTxs.length - 1 ? 1 : 0,
                  borderBottomStyle: "solid" as const,
                  borderBottomColor: "var(--color-border)",
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
                  <span style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.06em", fontFamily: "var(--font-body)" }}>EDIT ›</span>
                </div>
              </motion.button>
            );
          })
      )}
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
        // Removed min-height:100dvh — let content be natural height
        // Body scroll lock already prevents rubber-band scroll when no budget set
      }}
    >
      {/* Wallet illustration (reused from EmptyState) */}
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

      {/* Headline */}
      <div style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", letterSpacing: "-0.01em", lineHeight: 1.25, marginBottom: 10 }}>
        Set your {MONTH_FULL[month - 1]} budget<br />to get started
      </div>
      {/* Sub-label */}
      <div style={{ fontSize: 14, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.6, marginBottom: 32, maxWidth: 280 }}>
        Set a starting budget for {MONTH_FULL[month - 1]} — you can always adjust it later.
      </div>

      {/* CTA */}
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={() => setShowBudgetModal(true)}
        style={{
          background: `linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)`,
          color: "var(--accent-text)",
          border: "none", borderRadius: 16,
          padding: "16px 32px",
          fontSize: 16, fontWeight: 700, fontFamily: "var(--font-headline)",
          cursor: "pointer", letterSpacing: "0.02em",
          display: "flex", alignItems: "center", gap: 8,
        }}
      >
        + Add Budget Balance
      </motion.button>

      {/* Period label */}
      <div style={{ fontSize: 12, color: "var(--color-text-ghost)", fontFamily: "var(--font-body)", marginTop: 20, letterSpacing: "0.06em" }}>
        {MONTH_FULL[month - 1].toUpperCase()} {year}
      </div>
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
          --color-bg-input:    #0d1117;
          --color-bg-deep:     #080b10;
          --color-bg-nav:      #141920;
          --color-border:      #1a2333;
          --color-border-mid:  #1e2a38;
          --color-text-hi:     #f8fafc;
          --color-text-mid:    #cbd5e1;
          --color-text-lo:     #94a3b8;  /* 7.7:1 on dark bg — WCAG AA ✓ (was #475569 = 2.6:1 ✗) */
          --color-text-ghost:  #475569;  /* decorative only — swipe hint, dividers                */
        }
        /* ── T1  Light mode: Slate-50 bg, Slate-900 text (WCAG AA) ──────── */
        html[data-theme="light"] {
          --color-bg-page:     #f8fafc;   /* Slate-50  */
          --color-bg-card:     #ffffff;   /* White     */
          --color-bg-input:    #f1f5f9;   /* Slate-100 */
          --color-bg-deep:     #e2e8f0;   /* Slate-200 */
          --color-bg-nav:      #f1f5f9;   /* Slate-100 */
          --color-border:      #e2e8f0;   /* Slate-200 */
          --color-border-mid:  #cbd5e1;   /* Slate-300 */
          --color-text-hi:     #0f172a;   /* Slate-900 — 16:1 on white ✓  */
          --color-text-mid:    #334155;   /* Slate-700 — 10:1 ✓           */
          --color-text-lo:     #475569;   /* Slate-600 — 6.6:1 ✓          */
          --color-text-ghost:  #94a3b8;   /* Slate-400 — decorative only  */
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
        .focus-input:focus { border-color: var(--accent-border) !important; }

        /* Remove browser default focus outline on Settings theme tab buttons */
        button:focus { outline: none; }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

        /* Fix 4 — Placeholder text uses --color-text-hi so it reads correctly in light mode */
        ::placeholder { color: var(--color-text-lo); opacity: 1; }
        input::placeholder, textarea::placeholder { color: var(--color-text-lo); opacity: 1; }

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        html { font-size: 16px; }
        html, body {
          background: #080b10;
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
        /* safe-area-inset-top clears Dynamic Island on iPhone               */
        .header-pad   { padding: max(var(--sp-14), calc(var(--sp-12) + env(safe-area-inset-top))) var(--sp-6) 0; }
        .monthnav-pad { padding: var(--sp-4) var(--sp-6) 0; }

        /* Tablet / Desktop: 2-column grid, max 900px                        */
        @media (min-width: 768px) {
          .main-wrap    { max-width: 900px; }
          .header-pad   { padding: max(var(--sp-14), calc(var(--sp-12) + env(safe-area-inset-top))) var(--sp-8) 0; }
          .monthnav-pad { padding: var(--sp-4) var(--sp-8) 0; }
        }

        /* Dashboard card grid — always single column flex stack ──────────── */
        /* Issue 3: always 1-col, n-rows on all screen sizes                  */
        .dash-pad  { padding: var(--sp-4) var(--sp-4) 0; display: flex; flex-direction: column; gap: var(--sp-4); }
        @media (min-width: 768px) {
          .dash-pad  { padding: var(--sp-4) var(--sp-8) 0; }
          .col-left  { display: flex; flex-direction: column; gap: var(--sp-4); }
          .col-right { display: flex; flex-direction: column; }
        }

        /* ── Responsive FAB ─────────────────────────────────────────────── */
        /* safe-area-inset-bottom clears iPhone home indicator               */
        /* §3 spec: mobile-first max-width 400px, centered with margin auto  */
        .fab-btn { position: fixed; bottom: calc(var(--sp-8) + env(safe-area-inset-bottom)); left: var(--sp-4); right: var(--sp-4); width: auto; max-width: 400px; margin: 0 auto; transform: none; }
        @media (min-width: 768px) {
          .fab-btn { left: auto; right: var(--sp-8); max-width: 220px; margin: 0; }
        }

        /* ── Date picker — full-width mobile, auto-width on tablet+ ─────── */
        .date-input { width: 100%; box-sizing: border-box; }
        @media (min-width: 768px) {
          .date-input { width: auto; min-width: 200px; }
        }

        /* ── D6  Swipe hint fade-in — 800ms delay after dashboard renders ─ */
        @keyframes hintFade { from { opacity: 0; } to { opacity: 1; } }
        .swipe-hint { animation: hintFade 0.5s ease 0.8s both; }

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
        .skeleton {
          background: linear-gradient(90deg, #141920 25%, #1e2a38 50%, #141920 75%);
          background-size: 200% 100%;
          animation: shimmer 1.4s infinite;
          border-radius: 22px;
        }
      `}</style>

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
        {/* § 5  Radial gradient depth */}
        <div style={{
          position: "fixed", top: -100, left: "50%", transform: "translateX(-50%)",
          width: 500, height: 500, borderRadius: "50%", pointerEvents: "none", zIndex: 0,
          background: "radial-gradient(circle, var(--accent-muted) 0%, transparent 68%)",
        }} />

        <div style={{ position: "relative", zIndex: 1, paddingBottom: "calc(var(--sp-10) * 3 + env(safe-area-inset-bottom))" }}>

          {/* ════ HEADER ════ */}
          <div className="header-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: "0.20em", color: "var(--color-text-lo)", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>
                Personal Tracker
              </div>
              <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", margin: 0, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", lineHeight: 1.1 }}>
                Apsara <span style={{ color: "var(--accent)" }}>Spend</span>
              </h1>
              <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.06em", marginTop: 6, fontFamily: "var(--font-body)", display: "flex", alignItems: "center", gap: 8 }}>
                1 USD = 4,000 ៛ · Fixed rate
                {hasMonthBudget ? (
                  <button onClick={() => { setBudgetInput(String(monthBalance)); setShowBudgetModal(true); }}
                    style={{ background: "var(--accent-muted)", border: "1px solid var(--accent-border)", color: "var(--accent)", borderRadius: 99, padding: "1px 8px", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", cursor: "pointer", fontFamily: "var(--font-body)", display: "flex", alignItems: "center", gap: 4 }}>
                    ${(data.monthlyBalances[selectedMonth]).toFixed(0)} budget
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                      <path d="M7 1.5l1.5 1.5L3 8.5H1.5V7L7 1.5z" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                ) : (
                  <button onClick={() => setShowBudgetModal(true)}
                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 10, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "var(--font-body)", letterSpacing: "0.06em" }}>
                    + Set budget
                  </button>
                )}
              </div>
            </div>
            <button aria-label="Open settings" onClick={() => setShowSettings(true)}
              style={{ background: "var(--color-bg-nav)", border: "1px solid var(--color-border-mid)", borderRadius: 12, padding: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44, marginTop: 4 }}>
              <Settings className="icon-nav" color="var(--color-text-lo)" strokeWidth={1.8} />
            </button>
          </div>

          {/* ════ MONTH NAV ════ */}
          <div className="monthnav-pad" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button aria-label="Previous month" onClick={() => navigateMonth(-1)}
              style={{ background: "var(--color-bg-nav)", border: "1px solid var(--color-border-mid)", borderRadius: 10, padding: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44 }}>
              <ChevronLeft className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
            </button>

            <button aria-label="Open month picker" onClick={() => setShowPicker(true)}
              style={{ flex: 1, background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", padding: "4px 0" }}>
              <AnimatePresence mode="wait" custom={swipeDir}>
                <motion.div key={selectedMonth} custom={swipeDir} variants={slideVariants}
                  initial="enter" animate="center" exit="exit"
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text-hi)", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)", lineHeight: 1.1 }}>
                    {MONTH_FULL[month - 1]}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--color-text-lo)", marginTop: 4, fontWeight: 500, fontFamily: "var(--font-body)" }}>
                    {year}{isCurrentMonth && <span style={{ color: "var(--accent)", fontSize: 11, letterSpacing: "0.08em", marginLeft: 6, fontFamily: "var(--font-body)", fontWeight: 600 }}>● NOW</span>}
                  </div>
                </motion.div>
              </AnimatePresence>
            </button>

            <button aria-label="Next month" onClick={() => navigateMonth(1)} disabled={isCurrentMonth}
              style={{
                background: isCurrentMonth ? "transparent" : "var(--color-bg-nav)",
                border: "1px solid var(--color-border-mid)",
                borderRadius: 10, padding: 12,
                cursor: isCurrentMonth ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                minWidth: 44, minHeight: 44,
                opacity: isCurrentMonth ? 0.3 : 1,
                transition: "opacity 0.2s",
              }}>
              <ChevronRight className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
            </button>
          </div>

          {/* ════ SWIPEABLE DASHBOARD ════ */}
          <motion.div drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.12}
            onDragEnd={handleDragEnd}
            onClick={() => showFilterMenu && setShowFilterMenu(false)}
            style={{ cursor: "grab", touchAction: "pan-y" }}>
            <AnimatePresence mode="wait" custom={swipeDir}>
              <motion.div key={selectedMonth} custom={swipeDir} variants={slideVariants}
                initial="enter" animate="center" exit="exit"
                transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}>

                {/* § H-03  Skeleton while hydrating */}
                {!isLoaded ? (
                  <div className="dash-pad">
                    <div className="skeleton" style={{ height: 130 }} />
                    <div className="skeleton" style={{ height: 100 }} />
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
          </motion.div>

          <div className="swipe-hint" style={{ textAlign: "center", marginTop: 14, fontSize: 11, color: "var(--color-text-ghost)", letterSpacing: "0.1em", fontFamily: "var(--font-body)" }}>
            ← SWIPE TO NAVIGATE MONTHS →
          </div>
        </div>

        {/* ════ FAB — only shown after budget is set (S4) ════ */}
        {hasMonthBudget && (
        <motion.button
          whileTap={{ scale: fabDisabled ? 1 : 0.97 }}
          aria-label={fabDisabled ? "Monthly budget reached" : "Add new expense"}
          onClick={() => {
            if (fabDisabled) {
              showToast("This entry exceeds your planned monthly balance. Let's maintain your financial goals.", "warn");
              return;
            }
            setEditTx(null);
            setShowModal(true);
          }}
          className="fab-btn"
          style={{
            background: fabDisabled
              ? "#1e2a38"
              : "linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)",
            color: fabDisabled ? "var(--color-text-lo)" : "#0d0f14",
            border: fabDisabled ? "1px solid #2d3748" : "none",
            borderRadius: 20,
            padding: "16px 28px",
            cursor: fabDisabled ? "not-allowed" : "pointer",
            zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 8, letterSpacing: "0.04em",
            fontFamily: "var(--font-headline)",
            fontSize: 16, fontWeight: 700,
            animation: fabDisabled ? "none" : "pulseGlow 3s ease-in-out infinite",
            minHeight: 54,
            opacity: fabDisabled ? 0.6 : 1,
            boxShadow: fabDisabled ? "none" : "0 20px 50px rgba(0,0,0,0.5)",
            transition: "background 0.3s, color 0.3s, opacity 0.3s",
          }}>
          <Plus size={18} color={fabDisabled ? "var(--color-text-lo)" : "#0d0f14"} strokeWidth={3} />
          {fabDisabled ? "Budget Reached" : "Add Expense"}
        </motion.button>
        )}{/* end hasMonthBudget FAB gate */}

        {/* ════ MODALS ════ */}
        <AnimatePresence>
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
              onClose={() => { setShowModal(false); setEditTx(null); }}
            />
          )}

          {/* ── Set Budget Modal — O3 ── */}
          {showBudgetModal && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.92)", zIndex: 250, display: "flex", alignItems: "flex-end" }}
              onClick={() => setShowBudgetModal(false)}>
              <motion.div ref={budgetModalRef} initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 28, stiffness: 300 }}
                role="dialog" aria-modal="true" aria-label={monthBalance > 0 ? "Update Monthly Budget" : "Set Monthly Budget"}
                style={{ background: "var(--color-bg-card)", borderRadius: "24px 24px 0 0", padding: "28px 28px 56px", width: "100%", border: "1px solid var(--color-border-mid)", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
                onClick={(e) => e.stopPropagation()}>

                <div style={{ width: 40, height: 4, background: "var(--color-border-mid)", borderRadius: 2, margin: "0 auto 24px" }} />

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
                    type="text"
                    inputMode="decimal"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(sanitizeNum(e.target.value))}
                    onKeyDown={(e) => e.key === "Enter" && handleSetBudget()}
                    placeholder="0.00"
                    autoFocus
                    style={{
                      width: "100%", boxSizing: "border-box",
                      background: "var(--color-bg-input)", border: "2px solid var(--color-border)",
                      borderRadius: 14, padding: "16px 16px 16px 50px",
                      fontSize: 32, fontWeight: 800, color: "var(--color-text-hi)", outline: "none",
                      fontFamily: "var(--font-mono)", transition: "border-color 0.2s",
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
                  <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>💡</span>
                  <span style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                    You can update your budget at any time — changes apply immediately.
                  </span>
                </div>

                {/* Confirm button */}
                <button
                  onClick={handleSetBudget}
                  disabled={!budgetInput || parseFloat(budgetInput) <= 0}
                  style={{
                    width: "100%", padding: "16px", borderRadius: 16, border: "none",
                    background: !budgetInput || parseFloat(budgetInput) <= 0
                      ? "var(--color-border-mid)" : "linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)",
                    color: !budgetInput || parseFloat(budgetInput) <= 0 ? "var(--color-text-lo)" : "var(--accent-text)",
                    fontSize: 16, fontWeight: 700, fontFamily: "var(--font-headline)",
                    cursor: !budgetInput || parseFloat(budgetInput) <= 0 ? "not-allowed" : "pointer",
                    transition: "all 0.2s",
                  }}>
                  {monthBalance > 0 ? "Update Budget" : "Confirm Budget"}
                </button>
              </motion.div>
            </motion.div>
          )}

          {/* ── Settings sheet — data management only ── */}
          {showSettings && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.88)", zIndex: 200, display: "flex", alignItems: "flex-end" }}
              onClick={() => { setShowSettings(false); setResetConfirm(false); }}>
              <motion.div ref={settingsModalRef} initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 28, stiffness: 280 }}
                role="dialog" aria-modal="true" aria-label="Settings"
                style={{ background: "var(--color-bg-card)", borderRadius: "22px 22px 0 0", padding: "28px 28px 56px", width: "100%", border: "1px solid var(--color-border)", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
                onClick={(e) => e.stopPropagation()}>
                <div style={{ width: 36, height: 4, background: "var(--color-border-mid)", borderRadius: 2, margin: "0 auto 24px" }} />

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Settings className="icon-nav" color="var(--color-text-lo)" strokeWidth={1.8} />
                    <span style={{ fontSize: 22, fontWeight: 600, color: "var(--color-text-hi)", fontFamily: "var(--font-headline)", letterSpacing: "-0.01em" }}>Settings</span>
                  </div>
                  <button aria-label="Close settings"
                    onClick={() => { setShowSettings(false); setResetConfirm(false); }}
                    style={{ background: "var(--color-bg-nav)", border: "none", borderRadius: 9, padding: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, minHeight: 36 }}>
                    <X className="icon-nav" color="var(--color-text-lo)" strokeWidth={2} />
                  </button>
                </div>

                {/* ── Q5  Theme Mode ── */}
                <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>Appearance</div>
                <div style={{ background: "var(--color-bg-page)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                  {/* Theme toggle */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>Theme</span>
                    <div style={{ display: "flex", background: "var(--color-bg-nav)", borderRadius: 10, padding: 3, gap: 3 }}>
                      {(["dark", "system", "light"] as const).map((m) => (
                        <button key={m} onClick={() => setThemeMode(m)}
                          style={{
                            padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer",
                            background: themeMode === m ? "var(--accent)" : "transparent",
                            color: themeMode === m ? "var(--accent-text)" : "var(--color-text-lo)",
                            fontSize: 11, fontWeight: 600, fontFamily: "var(--font-body)",
                            textTransform: "capitalize", transition: "all 0.15s",
                          }}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Q4 — Palette switcher */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>Accent</span>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      {([
                        { id: "yellow",  hex: "#fbbf24" },
                        { id: "indigo",  hex: "#818cf8" },
                        { id: "emerald", hex: "#34d399" },
                        { id: "rose",    hex: "#fb7185" },
                      ] as const).map(({ id, hex }) => (
                        <button
                          key={id}
                          aria-label={`${id} palette`}
                          onClick={() => setPalette(id)}
                          style={{
                            width: 26, height: 26, borderRadius: "50%",
                            background: hex, border: "none", cursor: "pointer",
                            boxShadow: palette === id ? `0 0 0 2px var(--color-bg-card), 0 0 0 4px ${hex}` : "none",
                            transition: "box-shadow 0.15s",
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* C4 — Budget Mode toggle */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)" }}>Budget Mode</span>
                      <div style={{ display: "flex", background: "var(--color-bg-nav)", borderRadius: 10, padding: 3, gap: 3 }}>
                        {(["soft", "hard"] as const).map((m) => (
                          <button key={m} onClick={() => setConstraintMode(m)}
                            style={{
                              padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                              background: constraintMode === m ? "var(--accent)" : "transparent",
                              color: constraintMode === m ? "var(--accent-text)" : "var(--color-text-lo)",
                              fontSize: 11, fontWeight: 600, fontFamily: "var(--font-body)",
                              textTransform: "capitalize", transition: "all 0.15s",
                            }}>
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                      {constraintMode === "soft"
                        ? "⚡ Soft — allows over-budget entries with a warning."
                        : "🔒 Hard — requires confirmation before exceeding your budget."}
                    </div>
                  </div>
                </div>

                {/* Static rate info */}
                <div style={{ background: "var(--color-bg-page)", borderRadius: 12, padding: "12px 16px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4, fontFamily: "var(--font-body)", fontWeight: 600 }}>Exchange Rate</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text-lo)", fontFamily: "var(--font-mono)" }}>1 USD = 4,000 ៛</div>
                  </div>
                  <span style={{ fontSize: 11, background: "var(--color-border-mid)", color: "var(--color-text-lo)", padding: "4px 10px", borderRadius: 99, letterSpacing: "0.06em", fontFamily: "var(--font-body)", fontWeight: 600 }}>Fixed</span>
                </div>

                {/* E1 — Notifications */}
                {notifPermission !== "unsupported" && (
                  <>
                    <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>Notifications</div>
                    <div style={{ background: "var(--color-bg-page)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-mid)", fontFamily: "var(--font-body)", marginBottom: 2 }}>Budget Alerts</div>
                          <div style={{ fontSize: 11, color: "var(--color-text-lo)", fontFamily: "var(--font-body)" }}>
                            {notifPermission === "granted"  && "✓ Alerts at 80% and 95% of budget"}
                            {notifPermission === "denied"   && "Blocked — enable in browser settings"}
                            {notifPermission === "default"  && "Get notified when nearing your limit"}
                          </div>
                        </div>
                        {notifPermission === "default" && (
                          <button onClick={requestNotifPermission}
                            style={{
                              background: "var(--accent-muted)", border: "1px solid var(--accent-border)",
                              color: "var(--accent)", borderRadius: 8, padding: "6px 12px",
                              fontSize: 11, fontWeight: 600, fontFamily: "var(--font-body)", cursor: "pointer", whiteSpace: "nowrap",
                            }}>
                            Enable
                          </button>
                        )}
                        {notifPermission === "granted" && (
                          <span style={{ fontSize: 11, background: "#34d39920", color: "#34d399", border: "1px solid #34d39940", padding: "4px 10px", borderRadius: 99, fontFamily: "var(--font-body)", fontWeight: 600 }}>
                            Active
                          </span>
                        )}
                        {notifPermission === "denied" && (
                          <span style={{ fontSize: 11, background: "#ef444418", color: "#ef4444", border: "1px solid #ef444440", padding: "4px 10px", borderRadius: 99, fontFamily: "var(--font-body)", fontWeight: 600 }}>
                            Blocked
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}

                {/* Data Management */}
                <div style={{ fontSize: 11, color: "var(--color-text-lo)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>Data Management</div>
                <div style={{ background: "var(--color-bg-page)", borderRadius: 14, padding: 16 }}>
                  {!resetConfirm ? (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-lo)", fontFamily: "var(--font-body)", lineHeight: 1.4 }}>
                          Clear {MONTH_FULL[month - 1]} {year} data
                        </div>
                        <div style={{ fontSize: 12, color: "var(--color-text-lo)", marginTop: 4, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>Removes all entries for this month</div>
                      </div>
                      <button onClick={() => setResetConfirm(true)}
                        style={{ background: "#ef444418", border: "1px solid #ef444440", color: "#ef4444", borderRadius: 9, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-body)", whiteSpace: "nowrap" }}>
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 14, color: "var(--color-text-hi)", fontWeight: 600, marginBottom: 14, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                        Delete all {MONTH_FULL[month - 1]} {year} entries? This cannot be undone.
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setResetConfirm(false)}
                          style={{ flex: 1, padding: 12, background: "var(--color-bg-nav)", border: "1px solid #2d3748", color: "var(--color-text-lo)", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "var(--font-body)" }}>
                          Cancel
                        </button>
                        <button onClick={handleResetMonth}
                          style={{ flex: 1, padding: 12, background: "#ef4444", border: "none", color: "#fff", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: "var(--font-body)" }}>
                          Yes, clear
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ════ TOAST — role=alert announces to screen readers (A1) ════ */}
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
                background: toast.type === "warn" ? "#92400e" : toast.type === "success" ? "#064e3b" : "#1e3a5f",
                color:      toast.type === "warn" ? "#fde68a" : toast.type === "success" ? "#6ee7b7" : "#bfdbfe",
                border: `1px solid ${toast.type === "warn" ? "#b45309" : toast.type === "success" ? "#047857" : "#1d4ed8"}`,
                borderRadius: 14, padding: "12px 18px", fontSize: 13, fontWeight: 500,
                fontFamily: "var(--font-body)", lineHeight: 1.4,
                maxWidth: "calc(100vw - 48px)", textAlign: "center",
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              }}>
              {toast.msg}
            </motion.div>
          )}
        </AnimatePresence>

      </main>
    </>
  );
}
