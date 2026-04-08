"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence, PanInfo } from "framer-motion";
import {
  Settings, ChevronLeft, ChevronRight, X, Trash2, Plus,
  UtensilsCrossed, Bike, Zap, Users, ShoppingBag, MoreHorizontal,
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

const shiftMonth = (key: string, delta: number): string => {
  const { year, month } = parseMonthKey(key);
  const d = new Date(year, month - 1 + delta);
  return toMonthKey(d.getFullYear(), d.getMonth() + 1);
};

const sanitizeText = (s: string) => s.replace(/[<>"'`]/g, "").slice(0, 100);

// § 4  Amount sanitiser — numeric/decimal only, no scroll-value jumps
const sanitizeNum = (s: string) =>
  s.replace(/[^0-9.]/g, "").replace(/^(\d*\.?\d*).*$/, "$1");

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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          Budget
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color, transition: "color 0.3s" }}>
          {label}
        </span>
      </div>
      <div style={{ background: "#0d1117", borderRadius: 999, height: 7, overflow: "hidden" }}>
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          style={{ height: "100%", background: color, borderRadius: 999, boxShadow: `0 0 10px ${color}80` }}
        />
      </div>
      {/* § L-01  Labels derived from constants */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>$0</span>
        <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>${BUDGET_MIN}</span>
        <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>${BUDGET_MAX}</span>
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
        style={{ background: "#141920", borderRadius: 24, padding: "24px 20px 20px", border: "1px solid #1e2a38", width: "100%", maxWidth: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <button aria-label="Previous year" onClick={() => setPickerYear((y) => y - 1)}
            style={{ background: "#1e2530", border: "none", borderRadius: 10, padding: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft className="icon-nav" color="#94a3b8" strokeWidth={2} />
          </button>
          <span style={{ fontSize: 20, fontWeight: 700, color: "#f8fafc", letterSpacing: "-0.03em" }}>{pickerYear}</span>
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
                  fontWeight: isSelected ? 700 : 400, fontSize: 13, cursor: isFuture ? "default" : "pointer", transition: "all 0.15s",
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

  const defaultDate = tx?.date.slice(0, 10) ?? (() => {
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
  const amountRef = useRef<HTMLInputElement>(null);

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

  // § 2  Show denomination hint while user is typing an invalid KHR amount
  const handleKHRChange = (val: string) => {
    const clean = sanitizeKHR(val);
    setRawAmount(clean);
    const v = parseInt(clean, 10) || 0;
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

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "fixed", inset: 0, background: "rgba(5,7,12,0.9)", zIndex: 200, display: "flex", alignItems: "flex-end" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        style={{ background: "#0f131a", borderRadius: "24px 24px 0 0", padding: "20px 20px 40px", width: "100%", border: "1px solid #1e2a38", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ width: 40, height: 4, background: "#1e2a38", borderRadius: 2, margin: "0 auto 20px" }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: "#f8fafc", letterSpacing: "-0.02em" }}>
            {isEdit ? "Edit Expense" : "New Expense"}
          </span>
          <button aria-label="Close" onClick={onClose}
            style={{ background: "#1e2530", border: "none", borderRadius: 9, padding: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, minHeight: 36 }}>
            <X className="icon-nav" color="#64748b" strokeWidth={2} />
          </button>
        </div>

        {/* Currency toggle */}
        <div style={{ display: "flex", background: "#0d1117", borderRadius: 12, padding: 3, marginBottom: 14, gap: 4 }}>
          {(["USD", "KHR"] as Currency[]).map((c) => (
            <button key={c} onClick={() => handleCurrencyChange(c)}
              style={{
                flex: 1, padding: "9px 0", borderRadius: 9, border: "none", cursor: "pointer",
                fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", transition: "all 0.18s",
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
          style={{ position: "relative", marginBottom: khrHint ? 6 : 12 }}
        >
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 22, color: "#fbbf24", fontWeight: 800, pointerEvents: "none", zIndex: 1 }}>
            {currency === "USD" ? "$" : "៛"}
          </span>
          <input
            ref={amountRef}
            type="text"
            // § 2  KHR uses numeric keypad (integers only); USD uses decimal keypad
            inputMode={currency === "KHR" ? "numeric" : "decimal"}
            value={rawAmount}
            onChange={(e) =>
              currency === "KHR"
                ? handleKHRChange(e.target.value)
                : setRawAmount(sanitizeNum(e.target.value))
            }
            onBlur={handleAmountBlur}
            onWheel={(e) => e.currentTarget.blur()}
            placeholder="0"
            style={{
              width: "100%", boxSizing: "border-box",
              background: "#0d1117", border: `2px solid ${borderColor}`,
              borderRadius: 14, padding: "16px 48px 16px 46px",
              fontSize: 30, fontWeight: 800, color: "#f8fafc", outline: "none",
              fontFamily: "'DM Mono', monospace", transition: "border-color 0.2s",
            }}
          />
          {currency === "KHR" && parsedAmt > 0 && (
            <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#34d399", fontWeight: 600 }}>
              ≈ ${previewUSD.toFixed(2)}
            </span>
          )}
        </motion.div>

        {/* § 2  KHR denomination hint — shown live when user types a non-multiple of 100 */}
        {khrHint && (
          <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 10, paddingLeft: 4, letterSpacing: "0.02em" }}>
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
          style={{ width: "100%", boxSizing: "border-box", background: "#0d1117", border: "1.5px solid #1e2a38", borderRadius: 12, padding: "11px 14px", fontSize: 14, color: "#94a3b8", outline: "none", marginBottom: 12 }}
        />

        {/* Date */}
        <input
          type="date" value={date} max={localDateString()}
          onChange={(e) => setDate(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", background: "#0d1117", border: "1.5px solid #1e2a38", borderRadius: 12, padding: "11px 14px", fontSize: 14, color: "#94a3b8", outline: "none", marginBottom: 14, colorScheme: "dark" }}
        />

        {/* Category picker */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 7, marginBottom: 18 }}>
          {CATEGORIES.map((c) => {
            const active = cat === c.id;
            return (
              <button key={c.id} onClick={() => setCat(c.id)} aria-label={c.label} title={c.label}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "9px 2px 7px", borderRadius: 12, gap: 4,
                  border:     active ? `2px solid ${c.color}` : "2px solid transparent",
                  background: active ? `${c.color}18` : "#0d1117",
                  cursor: "pointer", transition: "all 0.15s", minHeight: 52,
                }}>
                <c.Icon className="icon-cat" color={active ? c.color : TEXT_TERTIARY} strokeWidth={1.8} />
                <span style={{ fontSize: 8, color: active ? c.color : TEXT_TERTIARY, fontWeight: 700, letterSpacing: "0.06em" }}>
                  {c.label.toUpperCase()}
                </span>
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10 }}>
          {isEdit && !deleteConfirm && (
            <button aria-label="Delete expense" onClick={() => setDeleteConfirm(true)}
              style={{ padding: 14, borderRadius: 14, border: "1px solid #ef444440", background: "#ef444412", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 48 }}>
              <Trash2 size={16} color="#ef4444" strokeWidth={2} />
            </button>
          )}
          {deleteConfirm && (
            <button onClick={() => { onDelete?.(tx!.id); onClose(); }}
              style={{ flex: 1, padding: 14, borderRadius: 14, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
              Confirm delete
            </button>
          )}
          {!deleteConfirm && (
            <button onClick={handleSave}
              style={{ flex: 1, padding: 14, borderRadius: 14, border: "none", background: "linear-gradient(135deg, #fbbf24, #f59e0b)", color: "#0d0f14", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "0 3px 16px rgba(251,191,36,0.3)" }}>
              {isEdit ? "Save Changes" : "Add Expense"}
            </button>
          )}
          {deleteConfirm && (
            <button onClick={() => setDeleteConfirm(false)}
              style={{ padding: "14px 16px", borderRadius: 14, border: "1px solid #1e2a38", background: "#1e2530", color: "#94a3b8", cursor: "pointer", fontSize: 13 }}>
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

  const monthTxs = data.transactions.filter((t) => {
    const d = new Date(t.date);
    return toMonthKey(d.getFullYear(), d.getMonth() + 1) === selectedMonth;
  });

  const totalUSD = pin2(monthTxs.reduce((s, t) => s + t.amountUSD, 0));

  const categoryTotals = CATEGORIES.map((c) => ({
    ...c,
    total: pin2(monthTxs.filter((t) => t.category === c.id).reduce((s, t) => s + t.amountUSD, 0)),
  })).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

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

  const SummaryCard = (
    <div style={{ background: "#0f131a", borderRadius: 22, padding: "20px 22px 18px", border: "1px solid #1a2333" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
            Total Spent
          </div>
          <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.05em", color: "#f8fafc", lineHeight: 1, fontFamily: "'Syne', sans-serif" }}>
            {currency === "KHR"
              ? `${Math.round(totalUSD * EXCHANGE_RATE).toLocaleString()} ៛`
              : `$${totalUSD.toFixed(2)}`}
          </div>
        </div>
        <div style={{ display: "flex", background: "#080b10", borderRadius: 10, padding: 3, gap: 3 }}>
          {(["USD", "KHR"] as Currency[]).map((c) => (
            <button key={c} onClick={() => setCurrency(c)}
              style={{
                padding: "6px 10px", borderRadius: 7, border: "none", cursor: "pointer",
                background: currency === c ? "#fbbf24" : "transparent",
                color:      currency === c ? "#0d0f14" : TEXT_TERTIARY,
                fontWeight: 700, fontSize: 11, letterSpacing: "0.06em", transition: "all 0.18s",
              }}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <BudgetBar total={totalUSD} />
    </div>
  );

  const BreakdownCard = hasBreakdown ? (
    <div style={{ background: "#0f131a", borderRadius: 22, padding: "18px 22px", border: "1px solid #1a2333" }}>
      <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 14 }}>
        Breakdown
      </div>
      {categoryTotals.filter((c) => c.total > 0).map((c, i) => {
        const pct = totalUSD > 0 ? (c.total / totalUSD) * 100 : 0;
        return (
          <motion.div key={c.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, duration: 0.2 }}
            style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: i < categoryTotals.filter(x => x.total > 0).length - 1 ? 13 : 0 }}>
            <CategoryIcon cat={c} active />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#cbd5e1" }}>{c.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: c.color, fontFamily: "'DM Mono', monospace" }}>{fmt(c.total)}</span>
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
  ) : null;

  const EmptyState = (
    <div style={{ textAlign: "center", padding: "40px 24px", background: "#0f131a", borderRadius: 22, border: "1px solid #1a2333", height: "100%" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🪷</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: TEXT_TERTIARY }}>No expenses yet for {MONTH_FULL[month - 1]}</div>
      <div style={{ fontSize: 12, marginTop: 4, color: TEXT_GHOST }}>Tap + Add Expense to get started</div>
    </div>
  );

  const TransactionList = hasData ? (
    <div style={{ background: "#0f131a", borderRadius: 22, padding: "18px 22px", border: "1px solid #1a2333", height: "100%" }}>
      <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 14 }}>
        {monthTxs.length} {monthTxs.length === 1 ? "entry" : "entries"}
      </div>
      {[...monthTxs]
        .sort((a, b) =>
          new Date(b.date).getTime() - new Date(a.date).getTime() ||
          b.id.localeCompare(a.id)
        )
        .map((tx, i) => {
          const cat     = CATEGORIES.find((c) => c.id === tx.category) ?? CATEGORIES[5];
          const d       = new Date(tx.date);
          const dateStr = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
          return (
            <motion.button
              key={tx.id}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
              onClick={() => { setEditTx(tx); setShowModal(true); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 12,
                padding: "10px 0",
                borderBottom: i < monthTxs.length - 1 ? "1px solid #0f1520" : "none",
                background: "none", border: "none",
                borderBottomWidth: i < monthTxs.length - 1 ? 1 : 0,
                borderBottomStyle: "solid" as const,
                borderBottomColor: "#0f1520",
                cursor: "pointer", textAlign: "left",
              }}>
              <CategoryIcon cat={cat} active />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tx.note}
                </div>
                <div style={{ fontSize: 11, color: TEXT_TERTIARY, marginTop: 2 }}>
                  {cat.label} · {dateStr}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#f8fafc", fontFamily: "'DM Mono', monospace" }}>
                  {fmt(tx.amountUSD)}
                </span>
                <span style={{ fontSize: 10, color: TEXT_TERTIARY, letterSpacing: "0.06em" }}>EDIT ›</span>
              </div>
            </motion.button>
          );
        })}
    </div>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        html, body { background: #080b10; min-height: 100dvh; overscroll-behavior: none; }
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

        /* ── § 5  Layout Shifter ────────────────────────────────────────── */
        /* Mobile-first: single-column, capped at 430px                     */
        .main-wrap    { max-width: 430px; margin: 0 auto; }
        .header-pad   { padding: 56px 22px 0; }
        .monthnav-pad { padding: 18px 22px 0; }

        /* § 5  Tablet/Desktop grid — layout shifts to 2-column at ≥768px  */
        @media (min-width: 768px) {
          .main-wrap    { max-width: 900px; }
          .header-pad   { padding: 56px 32px 0; }
          .monthnav-pad { padding: 18px 32px 0; }
        }

        /* Dashboard content grid                                            */
        .dash-pad  { padding: 16px 16px 0; display: flex; flex-direction: column; gap: 12px; }
        @media (min-width: 768px) {
          .dash-pad { padding: 16px 32px 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; gap: 14px; }
          .col-left { display: flex; flex-direction: column; gap: 14px; grid-column: 1; }
          .col-right { grid-column: 2; grid-row: 1 / -1; }
        }

        /* ── Responsive FAB ─────────────────────────────────────────────── */
        .fab-btn { position: fixed; bottom: 32px; left: 16px; right: 16px; width: auto; transform: none; }
        @media (min-width: 768px) {
          .fab-btn { left: auto; right: 32px; width: auto; min-width: 180px; }
        }

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
          fontFamily: "'DM Sans', system-ui, sans-serif",
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

        <div style={{ position: "relative", zIndex: 1, paddingBottom: 120 }}>

          {/* ════ HEADER ════ */}
          <div className="header-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 10, letterSpacing: "0.22em", color: TEXT_TERTIARY, textTransform: "uppercase", marginBottom: 6 }}>
                Personal Tracker
              </div>
              <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.04em", margin: 0, color: "#f8fafc", fontFamily: "'Syne', sans-serif" }}>
                Apsara <span style={{ color: "#fbbf24" }}>Spend</span>
              </h1>
              <div style={{ fontSize: 10, color: TEXT_TERTIARY, letterSpacing: "0.08em", marginTop: 5 }}>
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
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#f8fafc", letterSpacing: "-0.03em", fontFamily: "'Syne', sans-serif", lineHeight: 1 }}>
                    {MONTH_FULL[month - 1]}
                  </div>
                  <div style={{ fontSize: 13, color: TEXT_TERTIARY, marginTop: 2, fontWeight: 500 }}>
                    {year}{isCurrentMonth && <span style={{ color: "#fbbf24", fontSize: 10, letterSpacing: "0.08em", marginLeft: 6 }}>● NOW</span>}
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
            onDragEnd={handleDragEnd} style={{ cursor: "grab", touchAction: "pan-y" }}>
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
                    {/* Left column on tablet+: Summary + Breakdown */}
                    <div className="col-left">
                      {SummaryCard}
                      {BreakdownCard}
                    </div>
                    {/* Right column on tablet+: Transactions or Empty state */}
                    <div className="col-right">
                      {hasData ? TransactionList : EmptyState}
                    </div>
                  </div>
                )}

              </motion.div>
            </AnimatePresence>
          </motion.div>

          <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: TEXT_GHOST, letterSpacing: "0.1em" }}>
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
            padding: "16px 28px", fontSize: 15, fontWeight: 800,
            cursor: "pointer", zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 10, letterSpacing: "0.04em",
            fontFamily: "'Syne', sans-serif",
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
                style={{ background: "#0f131a", borderRadius: "22px 22px 0 0", padding: "20px 22px 44px", width: "100%", border: "1px solid #1a2333", borderBottom: "none", maxWidth: 480, margin: "0 auto" }}
                onClick={(e) => e.stopPropagation()}>
                <div style={{ width: 36, height: 4, background: "#1e2a38", borderRadius: 2, margin: "0 auto 20px" }} />

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Settings className="icon-nav" color="#64748b" strokeWidth={1.8} />
                    <span style={{ fontSize: 17, fontWeight: 700, color: "#f8fafc", fontFamily: "'Syne', sans-serif" }}>Settings</span>
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
                    <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Exchange Rate</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#64748b", fontFamily: "'DM Mono', monospace" }}>1 USD = 4,000 ៛</div>
                  </div>
                  <span style={{ fontSize: 10, background: "#1e2a38", color: TEXT_TERTIARY, padding: "4px 10px", borderRadius: 99, letterSpacing: "0.06em" }}>Fixed</span>
                </div>

                {/* Data Management */}
                <div style={{ fontSize: 11, color: TEXT_TERTIARY, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Data Management</div>
                <div style={{ background: "#080b10", borderRadius: 14, padding: "14px 16px" }}>
                  {!resetConfirm ? (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#64748b" }}>
                          Clear {MONTH_FULL[month - 1]} {year} data
                        </div>
                        <div style={{ fontSize: 11, color: TEXT_TERTIARY, marginTop: 3 }}>Removes all entries for this month</div>
                      </div>
                      <button onClick={() => setResetConfirm(true)}
                        style={{ background: "#ef444418", border: "1px solid #ef444440", color: "#ef4444", borderRadius: 9, padding: "7px 13px", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 13, color: "#fca5a5", fontWeight: 600, marginBottom: 12 }}>
                        Delete all {MONTH_FULL[month - 1]} {year} entries? This cannot be undone.
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setResetConfirm(false)}
                          style={{ flex: 1, padding: 10, background: "#1e2530", border: "1px solid #2d3748", color: "#94a3b8", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                          Cancel
                        </button>
                        <button onClick={handleResetMonth}
                          style={{ flex: 1, padding: 10, background: "#ef4444", border: "none", color: "#fff", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
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
                borderRadius: 14, padding: "11px 18px", fontSize: 13, fontWeight: 500,
                whiteSpace: "nowrap", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              }}>
              {toast.msg}
            </motion.div>
          )}
        </AnimatePresence>

      </main>
    </>
  );
}
