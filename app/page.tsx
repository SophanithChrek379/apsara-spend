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
  transactions: Transaction[];
  // exchangeRate removed — fixed at EXCHANGE_RATE constant (backward-compat: old field is accepted but ignored)
}

interface Toast {
  msg: string;
  type: "warn" | "info" | "success";
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EXCHANGE_RATE  = 4000;   // § 1  Fixed: 1 USD = 4,000 KHR
const BUDGET_MIN     = 300;    // § 1  Warning threshold
const BUDGET_MAX     = 350;    // § 1  Hard ceiling
const MAX_AMOUNT_USD = 9_999.99;
const KHR_STEP       = 100;    // § 2  Physical currency denomination step
const STORAGE_KEY    = "apsara_spend_v2";
const MONTHS         = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL     = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// § 5  Contrast-safe tertiary colour (≥ 4.5:1 on #080b10 and #0f131a)
// #334155 = 3.1:1 — fails WCAG AA at 11px → replaced with #475569 = 4.8:1 ✓
const TEXT_TERTIARY  = "#475569";
const TEXT_GHOST     = "#1e2a38"; // intentionally below threshold — decorative only

const CATEGORIES: { id: CategoryId; label: string; Icon: IconComp; color: string }[] = [
  { id: "food",    label: "Food",    Icon: UtensilsCrossed, color: "#fb923c" },
  { id: "transpo", label: "Transpo", Icon: Bike,            color: "#38bdf8" },
  { id: "bills",   label: "Bills",   Icon: Zap,             color: "#c084fc" },
  { id: "social",  label: "Social",  Icon: Users,           color: "#34d399" },
  { id: "shop",    label: "Shop",    Icon: ShoppingBag,     color: "#f472b6" },
  { id: "misc",    label: "Misc",    Icon: MoreHorizontal,  color: "#94a3b8" },
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

// § C-03  Schema validation — accepts old schema (with exchangeRate) for backward-compat
const isValidAppData = (val: unknown): val is AppData => {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj.transactions);
};

const loadData = (): { data: AppData | null; corrupted: boolean } => {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { data: null, corrupted: false };
    const parsed = JSON.parse(raw);
    if (!isValidAppData(parsed)) return { data: null, corrupted: true };
    return { data: { transactions: parsed.transactions }, corrupted: false };
  } catch {
    return { data: null, corrupted: true };
  }
};

// § C-01  Returns boolean so caller can surface a quota-exceeded toast
const saveData = (data: AppData): boolean => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
};

const defaultData = (): AppData => ({ transactions: [] });

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

function BudgetBar({ total }: { total: number }) {
  const pct   = Math.min((total / BUDGET_MAX) * 100, 100);
  const color = total > BUDGET_MAX ? "#ef4444" : total >= BUDGET_MIN ? "#f59e0b" : "#34d399";
  const label = total > BUDGET_MAX ? "Over budget!" : total >= BUDGET_MIN ? "Nearing limit" : "On track";
  // N1 — percentage of hard cap; capped display at 100%
  const pctDisplay = Math.min(Math.round((total / BUDGET_MAX) * 100), 100);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: "var(--font-body)", fontWeight: 600 }}>
          Budget
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {total > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: TEXT_TERTIARY, fontFamily: "var(--font-mono)" }}>
              {pctDisplay}%
            </span>
          )}
          <span style={{ fontSize: 11, fontWeight: 700, color, transition: "color 0.3s", fontFamily: "var(--font-body)" }}>
            {label}
          </span>
        </div>
      </div>
      <div style={{ background: "#0d1117", borderRadius: 999, height: 7, overflow: "hidden" }}>
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          style={{ height: "100%", background: color, borderRadius: 999, boxShadow: `0 0 10px ${color}80` }}
        />
      </div>
      {/* § L-01  Labels derived from constants */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY, fontFamily: "var(--font-body)" }}>$0</span>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY, fontFamily: "var(--font-body)" }}>${BUDGET_MIN}</span>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY, fontFamily: "var(--font-body)" }}>${BUDGET_MAX}</span>
      </div>
    </div>
  );
}

// ─── MonthPicker ──────────────────────────────────────────────────────────────

function MonthPicker({ current, onSelect, onClose }: {
  current: string; onSelect: (key: string) => void; onClose: () => void;
}) {
  const { year: curYear } = parseMonthKey(current);
  const [pickerYear, setPickerYear] = useState(curYear);
  const today = todayMonthKey();
  const atMax = pickerYear >= new Date().getFullYear();

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.88)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 16 }} animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 16 }}
        transition={{ type: "spring", damping: 22, stiffness: 300 }}
        style={{ background: "#141920", borderRadius: 24, padding: "24px 24px", border: "1px solid #1e2a38", width: "100%", maxWidth: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button aria-label="Previous year" onClick={() => setPickerYear((y) => y - 1)}
            style={{ background: "#1e2530", border: "none", borderRadius: 10, padding: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft className="icon-nav" color="#94a3b8" strokeWidth={2} />
          </button>
          <span style={{ fontSize: 20, fontWeight: 600, color: "#f8fafc", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)" }}>{pickerYear}</span>
          <button aria-label="Next year" onClick={() => setPickerYear((y) => y + 1)} disabled={atMax}
            style={{ background: atMax ? "#111" : "#1e2530", border: "none", borderRadius: 10, padding: 10, cursor: atMax ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronRight className="icon-nav" color={atMax ? TEXT_GHOST : "#94a3b8"} strokeWidth={2} />
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
                  border: isSelected ? "2px solid #fbbf24" : "1px solid transparent",
                  background: isSelected ? "#fbbf2418" : isToday ? "#1e2a38" : "transparent",
                  color: isFuture ? TEXT_GHOST : isSelected ? "#fbbf24" : "#cbd5e1",
                  fontFamily: "var(--font-body)",
                  fontWeight: isSelected ? 600 : 400, fontSize: 13, cursor: isFuture ? "default" : "pointer", transition: "all 0.15s",
                }}>
                {m}
                {isToday && !isSelected && (
                  <span style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", width: 4, height: 4, borderRadius: "50%", background: "#fbbf24" }} />
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

function EntryModal({ tx, selectedMonth, onSave, onDelete, onClose }: {
  tx: Transaction | null; selectedMonth: string;
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
  const amountRef   = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => amountRef.current?.focus(), 120); }, []);

  // § 2  Clear hint when switching currency
  const handleCurrencyChange = (c: Currency) => {
    setCurrency(c);
    setRawAmount("");
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

  const handleSave = () => {
    // § 2  KHR denomination guard — reject non-multiples of KHR_STEP at save time
    if (currency === "KHR" && !isValidKHR(rawAmount)) {
      setShake(true);
      setKhrHint(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    const usd = toUSD(rawAmount);
    if (!usd || usd <= 0 || usd > MAX_AMOUNT_USD) {
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    const catLabel = CATEGORIES.find((c) => c.id === cat)!.label;
    onSave({
      id:        tx?.id ?? genId(),
      amountUSD: usd,
      category:  cat,
      note:      sanitizeText(note) || catLabel,
      date:      new Date(`${date}T00:00:00`).toISOString(),
    });
    onClose();
  };

  const parsedAmt  = currency === "KHR" ? parseInt(rawAmount, 10) || 0 : parseFloat(rawAmount) || 0;
  const previewUSD = toUSD(rawAmount);
  const borderColor = shake ? "#ef4444" : khrHint ? "#f59e0b" : parsedAmt > 0 ? "#fbbf2450" : "#1e2a38";

  // Adaptive font size — shrinks as the display value gets longer to prevent overflow
  const displayVal = currency === "KHR" ? formatKHRDisplay(rawAmount) : rawAmount;
  const amountFontSize = displayVal.length <= 7 ? 32 : displayVal.length <= 10 ? 26 : 22;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.9)", zIndex: 200, display: "flex", alignItems: "flex-end" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        style={{ background: "#0f131a", borderRadius: "24px 24px 0 0", padding: "24px 24px 40px", width: "100%", border: "1px solid #1e2a38", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ width: 40, height: 4, background: "#1e2a38", borderRadius: 2, margin: "0 auto 24px" }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 25, fontWeight: 600, color: "#f8fafc", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)", lineHeight: 1.2 }}>
            {isEdit ? "Edit Expense" : "New Expense"}
          </span>
          <button aria-label="Close" onClick={onClose}
            style={{ background: "#1e2530", border: "none", borderRadius: 9, padding: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, minHeight: 36 }}>
            <X className="icon-nav" color="#64748b" strokeWidth={2} />
          </button>
        </div>

        {/* Currency toggle */}
        <div style={{ display: "flex", background: "#0d1117", borderRadius: 12, padding: 4, marginBottom: 16, gap: 4 }}>
          {(["USD", "KHR"] as Currency[]).map((c) => (
            <button key={c} onClick={() => handleCurrencyChange(c)}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 9, border: "none", cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontWeight: 600, fontSize: 14, letterSpacing: "0.04em", transition: "all 0.18s",
                background: currency === c ? "#fbbf24" : "transparent",
                color:      currency === c ? "#0d0f14" : TEXT_TERTIARY,
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
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 22, color: "#fbbf24", fontWeight: 700, fontFamily: "var(--font-headline)", pointerEvents: "none", zIndex: 1 }}>
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
              background: "#0d1117", border: `2px solid ${borderColor}`,
              borderRadius: 14,
              padding: rawAmount ? "16px 44px 16px 50px" : "16px 16px 16px 50px",
              fontSize: amountFontSize, fontWeight: 800, color: "#f8fafc", outline: "none",
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
                background: "#1e2530", border: "none", borderRadius: 6, padding: 5,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 2, minWidth: 28, minHeight: 28,
              }}
            >
              <X size={14} color="#64748b" strokeWidth={2.5} />
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

        {/* Note */}
        <input
          type="text" value={note}
          onChange={(e) => setNote(sanitizeText(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          placeholder="Note (optional, max 100 chars)..."
          maxLength={100}
          className="focus-input"
          style={{ width: "100%", boxSizing: "border-box", background: "#0d1117", border: "1.5px solid #1e2a38", borderRadius: 12, padding: "12px 16px", fontSize: 16, fontFamily: "var(--font-body)", lineHeight: 1.5, color: "#94a3b8", outline: "none", marginBottom: 16 }}
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
              background: "#0d1117",
              border: "1.5px solid #1e2a38",
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
              color: date ? "#e2e8f0" : TEXT_TERTIARY,
            }}>
              {date ? formatDisplayDate(date) : "Select date"}
            </span>
            <CalendarDays
              size={16}
              color="#64748b"
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
                  background: active ? `${c.color}18` : "#0d1117",
                  cursor: "pointer", transition: "all 0.15s", minHeight: 60,
                }}>
                <c.Icon className="icon-cat" color={active ? c.color : TEXT_TERTIARY} strokeWidth={1.8} />
                <span style={{ fontSize: 10, color: active ? c.color : TEXT_TERTIARY, fontWeight: 700, fontFamily: "var(--font-body)", letterSpacing: "0.05em" }}>
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
              style={{ flex: 1, padding: 14, borderRadius: 14, border: "none", background: "linear-gradient(135deg, #fbbf24, #f59e0b)", color: "#0d0f14", fontWeight: 700, fontSize: 16, fontFamily: "var(--font-body)", cursor: "pointer", boxShadow: "0 3px 16px rgba(251,191,36,0.3)" }}>
              {isEdit ? "Save Changes" : "Add Expense"}
            </button>
          )}
          {deleteConfirm && (
            <button onClick={() => setDeleteConfirm(false)}
              style={{ padding: "14px 16px", borderRadius: 14, border: "1px solid #1e2a38", background: "#1e2530", color: "#94a3b8", cursor: "pointer", fontSize: 14, fontFamily: "var(--font-body)" }}>
              Cancel
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

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

  useEffect(() => {
    if (!isLoaded) return;
    const ok = saveData(data);
    if (!ok) showToast("Storage quota exceeded — data may not be saved.", "warn");
  }, [data, isLoaded, showToast]);

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

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  const handleSave = (tx: Transaction) => {
    setData((d) => {
      const exists = d.transactions.some((t) => t.id === tx.id);
      return {
        ...d,
        transactions: exists
          ? d.transactions.map((t) => (t.id === tx.id ? tx : t))
          : [tx, ...d.transactions],
      };
    });
    showToast(editTx ? "Expense updated." : "Expense added!", "success");
    setEditTx(null);
  };

  const handleDelete = (id: string) => {
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
    <div style={{ background: "#0f131a", borderRadius: 22, border: "1px solid #1a2333", overflow: "hidden" }}>

      {/* ── Summary section ── */}
      <div style={{ padding: "24px 24px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>
              Total Spent
            </div>
            <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: "-0.03em", color: "#f8fafc", lineHeight: 1, fontFamily: "var(--font-headline)" }}>
              {currency === "KHR"
                ? `${Math.round(totalUSD * EXCHANGE_RATE).toLocaleString()} ៛`
                : `$${totalUSD.toFixed(2)}`}
            </div>
            {/* N3 — period label — makes it unambiguous when time-travelling */}
            <div style={{ fontSize: 11, color: TEXT_TERTIARY, marginTop: 6, fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}>
              {MONTH_FULL[month - 1]} {year}
            </div>
          </div>
          <div style={{ display: "flex", background: "#080b10", borderRadius: 10, padding: 3, gap: 3 }}>
            {(["USD", "KHR"] as Currency[]).map((c) => (
              <button key={c} onClick={() => setCurrency(c)}
                style={{
                  padding: "6px 11px", borderRadius: 7, border: "none", cursor: "pointer",
                  background: currency === c ? "#fbbf24" : "transparent",
                  color:      currency === c ? "#0d0f14" : TEXT_TERTIARY,
                  fontWeight: 700, fontSize: 12, fontFamily: "var(--font-body)", letterSpacing: "0.05em", transition: "all 0.18s",
                }}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <BudgetBar total={totalUSD} />
      </div>

      {/* ── Hairline divider + Breakdown section (only when there is data) ── */}
      {hasBreakdown && (
        <>
          <div style={{ height: 1, background: "#1a2333", margin: "0 24px" }} />
          <div style={{ padding: "20px 24px 24px" }}>
            <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 16, fontFamily: "var(--font-body)", fontWeight: 600 }}>
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
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#cbd5e1", fontFamily: "var(--font-body)" }}>{c.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c.color, fontFamily: "var(--font-mono)" }}>{fmt(c.total)}</span>
                    </div>
                    <div style={{ background: "#080b10", borderRadius: 999, height: 4, overflow: "hidden" }}>
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
    <div style={{ textAlign: "center", padding: "48px 24px", background: "#0f131a", borderRadius: 22, border: "1px solid #1a2333", height: "100%", minHeight: 220, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>

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
        <path d="M8 36 Q8 28 16 28 H80 Q88 28 88 36 V44 H8 Z" fill="#141920" />
        {/* Flap fold line */}
        <line x1="8" y1="44" x2="88" y2="44" stroke="#2d3f55" strokeWidth="1" />
        {/* Card slot inside wallet */}
        <rect x="16" y="50" width="40" height="14" rx="3" fill="#141920" stroke="#2d3f55" strokeWidth="1" />
        {/* Card shine */}
        <rect x="20" y="54" width="12" height="2" rx="1" fill="#2d3f55" />
        {/* Amber coin — hovering above wallet, signalling emptiness */}
        <circle cx="90" cy="22" r="14" fill="#fbbf2420" stroke="#fbbf24" strokeWidth="1.5" />
        {/* Dollar sign in coin */}
        <text x="90" y="27" textAnchor="middle" fill="#fbbf24" fontSize="12" fontWeight="700" fontFamily="system-ui">$</text>
        {/* Small sparkle dots — top right */}
        <circle cx="108" cy="10" r="2" fill="#fbbf2450" />
        <circle cx="114" cy="18" r="1.5" fill="#fbbf2430" />
        <circle cx="104" cy="4"  r="1"   fill="#fbbf2440" />
        {/* Dashed lines inside wallet — indicating no bills */}
        <line x1="62" y1="54" x2="78" y2="54" stroke="#2d3f55" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
        <line x1="62" y1="58" x2="74" y2="58" stroke="#2d3f55" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
      </svg>

      <div style={{ fontSize: 16, fontWeight: 600, color: TEXT_TERTIARY, fontFamily: "var(--font-body)", lineHeight: 1.4 }}>No expenses yet for {MONTH_FULL[month - 1]}</div>
      <div style={{ fontSize: 12, marginTop: 6, color: TEXT_GHOST, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>Tap + Add Expense to get started</div>
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
    <div style={{ background: "#0f131a", borderRadius: 22, padding: "24px 24px", border: "1px solid #1a2333", height: "100%" }}>

      {/* ── Header row: count label + category filter dropdown ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: "var(--font-body)", fontWeight: 600 }}>
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
              background: filterCategory !== "all" ? `${activeCat?.color}18` : "#141920",
              border: filterCategory !== "all" ? `1px solid ${activeCat?.color}40` : "1px solid #1e2a38",
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
            <span style={{ fontSize: 11, fontWeight: 600, color: filterCategory !== "all" ? activeCat?.color : TEXT_TERTIARY, fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}>
              {filterCategory === "all" ? "All" : activeCat?.label}
            </span>
            <ChevronDown
              size={11}
              color={filterCategory !== "all" ? activeCat?.color : TEXT_TERTIARY}
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
                  background: "#141920", border: "1px solid #1e2a38",
                  borderRadius: 12, padding: "6px", zIndex: 100,
                  minWidth: 148, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                }}
              >
                {/* All option */}
                <button
                  onClick={() => { setFilterCategory("all"); setShowFilterMenu(false); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 8, border: "none",
                    background: filterCategory === "all" ? "#1e2a38" : "transparent",
                    cursor: "pointer", transition: "background 0.12s",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: filterCategory === "all" ? 600 : 400, color: filterCategory === "all" ? "#f8fafc" : "#94a3b8", fontFamily: "var(--font-body)" }}>
                    All categories
                  </span>
                </button>

                {/* Divider */}
                <div style={{ height: 1, background: "#1e2a38", margin: "4px 0" }} />

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
                    <span style={{ fontSize: 13, fontWeight: filterCategory === c.id ? 600 : 400, color: filterCategory === c.id ? c.color : "#94a3b8", fontFamily: "var(--font-body)" }}>
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
        <div style={{ textAlign: "center", padding: "24px 0", color: TEXT_TERTIARY, fontSize: 13, fontFamily: "var(--font-body)" }}>
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
                  borderBottomColor: "#0f1520",
                  cursor: "pointer", textAlign: "left",
                }}>
                <CategoryIcon cat={cat} active />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                    {tx.note}
                  </div>
                  <div style={{ fontSize: 12, color: TEXT_TERTIARY, marginTop: 4, fontFamily: "var(--font-body)", lineHeight: 1.4 }}>
                    {cat.label} · {dateStr}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#f8fafc", fontFamily: "var(--font-mono)" }}>
                    {fmt(tx.amountUSD)}
                  </span>
                  <span style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.06em", fontFamily: "var(--font-body)" }}>EDIT ›</span>
                </div>
              </motion.button>
            );
          })
      )}
    </div>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        :root {
          --font-headline: 'Poppins', system-ui, sans-serif;
          --font-body:     'Open Sans', system-ui, sans-serif;
          --font-mono:     'DM Mono', ui-monospace, monospace;

          /* ── Grid-8 spacing tokens (base unit = 8px) ─────────────────── */
          --sp-1:  4px;   /* 0.5 ×8  — tight icon gap, micro margins        */
          --sp-2:  8px;   /* 1  ×8  — small gaps, tight padding              */
          --sp-3:  12px;  /* 1.5×8  — card inner gaps (half-step)            */
          --sp-4:  16px;  /* 2  ×8  — standard padding, section margins      */
          --sp-5:  20px;  /* 2.5×8  — card top/bottom padding (half-step)    */
          --sp-6:  24px;  /* 3  ×8  — section side padding                   */
          --sp-8:  32px;  /* 4  ×8  — large section gaps, FAB bottom         */
          --sp-10: 40px;  /* 5  ×8  — modal bottom safe padding              */
          --sp-12: 48px;  /* 6  ×8  — large vertical rhythm                  */
          --sp-14: 56px;  /* 7  ×8  — header top clearance                   */
        }
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

        /* Dashboard card grid — 12px gap on mobile, 16px on tablet grid    */
        .dash-pad  { padding: var(--sp-4) var(--sp-4) 0; display: flex; flex-direction: column; gap: var(--sp-3); }
        @media (min-width: 768px) {
          .dash-pad  { padding: var(--sp-4) var(--sp-8) 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; gap: var(--sp-4); }
          .col-left  { display: flex; flex-direction: column; gap: var(--sp-4); grid-column: 1; }
          .col-right { grid-column: 2; grid-row: 1 / -1; }
        }

        /* ── Responsive FAB ─────────────────────────────────────────────── */
        /* safe-area-inset-bottom clears iPhone home indicator               */
        .fab-btn { position: fixed; bottom: calc(var(--sp-8) + env(safe-area-inset-bottom)); left: var(--sp-4); right: var(--sp-4); width: auto; transform: none; }
        @media (min-width: 768px) {
          .fab-btn { left: auto; right: var(--sp-8); width: auto; min-width: 180px; }
        }

        /* ── D2  Input focus ring — amber border on keyboard focus ─────── */
        .focus-input:focus { border-color: rgba(251,191,36,0.5) !important; }

        /* ── Date picker — full-width mobile, auto-width on tablet+ ─────── */
        .date-input { width: 100%; box-sizing: border-box; }
        @media (min-width: 768px) {
          .date-input { width: auto; min-width: 200px; }
        }

        /* ── D6  Swipe hint fade-in — 800ms delay after dashboard renders ─ */
        @keyframes hintFade { from { opacity: 0; } to { opacity: 1; } }
        .swipe-hint { animation: hintFade 0.5s ease 0.8s both; }

        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 0 16px rgba(251,191,36,0.2); }
          50%       { box-shadow: 0 0 28px rgba(251,191,36,0.45); }
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
          background: "#080b10",
          minHeight: "100dvh",
          color: "#e2e8f0",
          position: "relative",
          userSelect: "none",
        }}
      >
        {/* § 5  Radial gradient depth */}
        <div style={{
          position: "fixed", top: -100, left: "50%", transform: "translateX(-50%)",
          width: 500, height: 500, borderRadius: "50%", pointerEvents: "none", zIndex: 0,
          background: "radial-gradient(circle, rgba(251,191,36,0.06) 0%, transparent 68%)",
        }} />

        <div style={{ position: "relative", zIndex: 1, paddingBottom: "calc(var(--sp-10) * 3 + env(safe-area-inset-bottom))" }}>

          {/* ════ HEADER ════ */}
          <div className="header-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: "0.20em", color: TEXT_TERTIARY, textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>
                Personal Tracker
              </div>
              <h1 style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.02em", margin: 0, color: "#f8fafc", fontFamily: "var(--font-headline)", lineHeight: 1.1 }}>
                Apsara <span style={{ color: "#fbbf24" }}>Spend</span>
              </h1>
              <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.06em", marginTop: 6, fontFamily: "var(--font-body)" }}>
                1 USD = 4,000 ៛ · Fixed rate
              </div>
            </div>
            <button aria-label="Open settings" onClick={() => setShowSettings(true)}
              style={{ background: "#141920", border: "1px solid #1e2a38", borderRadius: 12, padding: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44, marginTop: 4 }}>
              <Settings className="icon-nav" color="#64748b" strokeWidth={1.8} />
            </button>
          </div>

          {/* ════ MONTH NAV ════ */}
          <div className="monthnav-pad" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button aria-label="Previous month" onClick={() => navigateMonth(-1)}
              style={{ background: "#141920", border: "1px solid #1e2a38", borderRadius: 10, padding: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44 }}>
              <ChevronLeft className="icon-nav" color="#64748b" strokeWidth={2} />
            </button>

            <button aria-label="Open month picker" onClick={() => setShowPicker(true)}
              style={{ flex: 1, background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", padding: "4px 0" }}>
              <AnimatePresence mode="wait" custom={swipeDir}>
                <motion.div key={selectedMonth} custom={swipeDir} variants={slideVariants}
                  initial="enter" animate="center" exit="exit"
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 31, fontWeight: 700, color: "#f8fafc", letterSpacing: "-0.01em", fontFamily: "var(--font-headline)", lineHeight: 1.1 }}>
                    {MONTH_FULL[month - 1]}
                  </div>
                  <div style={{ fontSize: 13, color: TEXT_TERTIARY, marginTop: 4, fontWeight: 500, fontFamily: "var(--font-body)" }}>
                    {year}{isCurrentMonth && <span style={{ color: "#fbbf24", fontSize: 11, letterSpacing: "0.08em", marginLeft: 6, fontFamily: "var(--font-body)", fontWeight: 600 }}>● NOW</span>}
                  </div>
                </motion.div>
              </AnimatePresence>
            </button>

            <button aria-label="Next month" onClick={() => navigateMonth(1)} disabled={isCurrentMonth}
              style={{ background: isCurrentMonth ? "transparent" : "#141920", border: isCurrentMonth ? "1px solid #0d1117" : "1px solid #1e2a38", borderRadius: 10, padding: 12, cursor: isCurrentMonth ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44 }}>
              <ChevronRight className="icon-nav" color={isCurrentMonth ? TEXT_GHOST : "#64748b"} strokeWidth={2} />
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

          <div className="swipe-hint" style={{ textAlign: "center", marginTop: 14, fontSize: 11, color: TEXT_GHOST, letterSpacing: "0.1em", fontFamily: "var(--font-body)" }}>
            ← SWIPE TO NAVIGATE MONTHS →
          </div>
        </div>

        {/* ════ FAB — full-width mobile · right-aligned tablet+ ════ */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          aria-label="Add new expense"
          onClick={() => { setEditTx(null); setShowModal(true); }}
          className="fab-btn"
          style={{
            background: "linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)",
            color: "#0d0f14", border: "none", borderRadius: 20,
            padding: "16px 28px",
            cursor: "pointer", zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 8, letterSpacing: "0.04em",
            fontFamily: "var(--font-headline)",
            fontSize: 16, fontWeight: 700,
            animation: "pulseGlow 3s ease-in-out infinite",
            minHeight: 54,
          }}>
          <Plus size={18} color="#0d0f14" strokeWidth={3} />
          Add Expense
        </motion.button>

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
            <EntryModal tx={editTx} selectedMonth={selectedMonth}
              onSave={handleSave} onDelete={handleDelete}
              onClose={() => { setShowModal(false); setEditTx(null); }}
            />
          )}

          {/* ── Settings sheet — data management only ── */}
          {showSettings && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.88)", zIndex: 200, display: "flex", alignItems: "flex-end" }}
              onClick={() => { setShowSettings(false); setResetConfirm(false); }}>
              <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 28, stiffness: 280 }}
                style={{ background: "#0f131a", borderRadius: "22px 22px 0 0", padding: "24px 24px 48px", width: "100%", border: "1px solid #1a2333", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
                onClick={(e) => e.stopPropagation()}>
                <div style={{ width: 36, height: 4, background: "#1e2a38", borderRadius: 2, margin: "0 auto 24px" }} />

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Settings className="icon-nav" color="#64748b" strokeWidth={1.8} />
                    <span style={{ fontSize: 25, fontWeight: 600, color: "#f8fafc", fontFamily: "var(--font-headline)", letterSpacing: "-0.01em" }}>Settings</span>
                  </div>
                  <button aria-label="Close settings"
                    onClick={() => { setShowSettings(false); setResetConfirm(false); }}
                    style={{ background: "#1e2530", border: "none", borderRadius: 9, padding: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, minHeight: 36 }}>
                    <X className="icon-nav" color="#64748b" strokeWidth={2} />
                  </button>
                </div>

                {/* Static rate info */}
                <div style={{ background: "#080b10", borderRadius: 12, padding: "12px 16px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4, fontFamily: "var(--font-body)", fontWeight: 600 }}>Exchange Rate</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#64748b", fontFamily: "var(--font-mono)" }}>1 USD = 4,000 ៛</div>
                  </div>
                  <span style={{ fontSize: 11, background: "#1e2a38", color: TEXT_TERTIARY, padding: "4px 10px", borderRadius: 99, letterSpacing: "0.06em", fontFamily: "var(--font-body)", fontWeight: 600 }}>Fixed</span>
                </div>

                {/* Data Management */}
                <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-body)", fontWeight: 600 }}>Data Management</div>
                <div style={{ background: "#080b10", borderRadius: 14, padding: 16 }}>
                  {!resetConfirm ? (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#64748b", fontFamily: "var(--font-body)", lineHeight: 1.4 }}>
                          Clear {MONTH_FULL[month - 1]} {year} data
                        </div>
                        <div style={{ fontSize: 12, color: TEXT_TERTIARY, marginTop: 4, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>Removes all entries for this month</div>
                      </div>
                      <button onClick={() => setResetConfirm(true)}
                        style={{ background: "#ef444418", border: "1px solid #ef444440", color: "#ef4444", borderRadius: 9, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-body)", whiteSpace: "nowrap" }}>
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 14, color: "#fca5a5", fontWeight: 600, marginBottom: 14, fontFamily: "var(--font-body)", lineHeight: 1.5 }}>
                        Delete all {MONTH_FULL[month - 1]} {year} entries? This cannot be undone.
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setResetConfirm(false)}
                          style={{ flex: 1, padding: 12, background: "#1e2530", border: "1px solid #2d3748", color: "#94a3b8", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "var(--font-body)" }}>
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

        {/* ════ TOAST ════ */}
        <AnimatePresence>
          {toast && (
            <motion.div key={toast.msg}
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
