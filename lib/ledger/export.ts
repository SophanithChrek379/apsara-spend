import type { AppData, Transaction } from "@/lib/types";
import { STORAGE_KEY } from "@/lib/constants";
import { CATEGORY_IDS } from "@/lib/types";
import { dayFromIso } from "@/lib/calendar-day";

/**
 * Local backup / export.
 *
 * Deliberately reads the raw localStorage values rather than trusting the live
 * React state: the point of a backup taken before a migration is to capture
 * what is actually on disk, including anything the in-memory ledger may have
 * already reconciled away.
 */

export const BACKUP_VERSION = 1;

export interface Backup {
  app: "apsara-spend";
  backup_version: number;
  exported_at: string;
  counts: { transactions: number; budgets: number };
  /** The live ledger as the UI currently sees it. */
  ledger: AppData;
  preferences: Record<string, string | null>;
  /**
   * Every apsara_* localStorage key, verbatim. This is the true safety net —
   * if a restore ever needs something this format didn't anticipate, it's here.
   */
  localStorage_raw: Record<string, unknown>;
}

const APSARA_PREFIX = "apsara_";

const collectRawStorage = (): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (typeof window === "undefined") return out;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(APSARA_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    // Store parsed JSON where possible so the file is readable, else the string.
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  }
  return out;
};

export const buildBackup = (ledger: AppData): Backup => {
  const raw = collectRawStorage();

  // Prefer the on-disk ledger; fall back to live state if the cache is absent.
  const onDisk = raw[STORAGE_KEY] as Partial<AppData> | undefined;
  const transactions = Array.isArray(onDisk?.transactions)
    ? (onDisk!.transactions as Transaction[])
    : ledger.transactions;
  const monthlyBalances =
    onDisk?.monthlyBalances && typeof onDisk.monthlyBalances === "object"
      ? (onDisk.monthlyBalances as Record<string, number>)
      : ledger.monthlyBalances;

  return {
    app: "apsara-spend",
    backup_version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    counts: {
      transactions: transactions.length,
      budgets: Object.keys(monthlyBalances).length,
    },
    ledger: { schema_version: ledger.schema_version, transactions, monthlyBalances },
    preferences: {
      theme:      typeof window === "undefined" ? null : localStorage.getItem("apsara_theme"),
      palette:    typeof window === "undefined" ? null : localStorage.getItem("apsara_palette"),
      constraint: typeof window === "undefined" ? null : localStorage.getItem("apsara_constraint"),
    },
    localStorage_raw: raw,
  };
};

/**
 * RFC 4180 quoting — notes can contain commas.
 *
 * Also neutralises spreadsheet formula injection: Excel and Sheets evaluate a
 * cell starting with = + - @ (or a leading tab/CR), and notes are free text.
 * A leading apostrophe makes the value display literally instead.
 */
const csvCell = (v: string | number): string => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Human-readable export for eyeballing against the database. Uses the local
 * calendar day, matching what the app displays and what spent_on stores.
 */
export const buildCsv = (ledger: AppData): string => {
  const localDay = (iso: string) => dayFromIso(iso) || iso;

  const rows = [...ledger.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));

  const lines = [
    ["date", "category", "note", "amount_usd", "amount_khr", "id"].join(","),
    ...rows.map((t) =>
      [
        localDay(t.date),
        (CATEGORY_IDS as readonly string[]).includes(t.category) ? t.category : "misc",
        csvCell(t.note),
        t.amountUSD.toFixed(2),
        Math.round(t.amountUSD * 4000),
        t.id,
      ].join(","),
    ),
  ];

  const total = rows.reduce((s, t) => s + t.amountUSD, 0);
  lines.push("");
  lines.push(`# ${rows.length} entries, total $${total.toFixed(2)}`);
  for (const [month, amount] of Object.entries(ledger.monthlyBalances).sort()) {
    lines.push(`# budget ${month},$${Number(amount).toFixed(2)}`);
  }

  return lines.join("\n");
};

const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Triggers a browser download without leaking the object URL. */
const download = (filename: string, contents: string, mime: string) => {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in Safari before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** @returns the transaction count written, so the caller can confirm in a toast. */
export const downloadBackupJson = (ledger: AppData): number => {
  const backup = buildBackup(ledger);
  download(`apsara-spend-backup-${stamp()}.json`, JSON.stringify(backup, null, 2), "application/json");
  return backup.counts.transactions;
};

export const downloadCsv = (ledger: AppData): number => {
  download(`apsara-spend-${stamp()}.csv`, buildCsv(ledger), "text/csv");
  return ledger.transactions.length;
};
