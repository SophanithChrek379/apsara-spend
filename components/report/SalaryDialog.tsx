"use client";

// ─── Salary entry ─────────────────────────────────────────────────────────────
//
// One figure per calendar year: salary changes year to year, so a raise is a new
// year's row (or a revision of this year's), never an edit to history. Only
// reachable from the unlocked income card — the dialog never mounts while the
// salary lock is closed.

import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { MAX_INCOME_USD, type AnnualIncome } from "@/lib/types";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SalaryDialog({
  open, onOpenChange, income, defaultYear, onSave, onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  income: AnnualIncome;
  defaultYear: number;
  onSave: (year: number, amount: number) => Promise<void>;
  onDelete: (year: number) => Promise<void>;
}) {
  const thisYear = new Date().getFullYear();
  const years = React.useMemo(() => {
    const span = new Set<number>(Object.keys(income).map(Number));
    for (let y = thisYear + 1; y >= thisYear - 5; y--) span.add(y);
    return Array.from(span).sort((a, b) => b - a);
  }, [income, thisYear]);

  const [year, setYear]     = React.useState(defaultYear);
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy]     = React.useState<"save" | number | null>(null);
  const [error, setError]   = React.useState<string | null>(null);

  // Each opening starts on the report's year, pre-filled with what's on file.
  React.useEffect(() => {
    if (!open) return;
    setYear(defaultYear);
    setAmount(income[defaultYear] !== undefined ? String(income[defaultYear]) : "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultYear]);

  const pickYear = (y: number) => {
    setYear(y);
    setAmount(income[y] !== undefined ? String(income[y]) : "");
    setError(null);
  };

  const parsed = Number(amount.replace(/[$,\s]/g, ""));
  const valid  = amount.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_INCOME_USD;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setError(`Enter an amount between $0.01 and ${usd(MAX_INCOME_USD)}.`);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      await onSave(year, Math.round(parsed * 100) / 100);
    } catch {
      setError("Couldn't save. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (y: number) => {
    setBusy(y);
    setError(null);
    try {
      await onDelete(y);
      if (y === year) setAmount("");
    } catch {
      setError("Couldn't remove that year. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const saved = Object.entries(income)
    .map(([y, a]) => ({ year: Number(y), amount: a }))
    .sort((a, b) => b.year - a.year);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 rounded-2xl border-border bg-card font-sans sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-extrabold tracking-[-0.02em]">
            Annual salary
          </DialogTitle>
          <DialogDescription className="text-xs leading-[1.5]">
            Enter what you earn in a year, in USD. Each year gets its own figure, so a
            raise never rewrites past years.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="grid grid-cols-[110px_1fr] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="salary-year" className="text-xs text-muted-foreground">Year</Label>
              <Select value={String(year)} onValueChange={(v) => pickYear(Number(v))}>
                <SelectTrigger id="salary-year" className="w-full rounded-[10px] bg-background font-numeric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)} className="font-numeric">{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="salary-amount" className="text-xs text-muted-foreground">Salary (USD / year)</Label>
              <Input
                id="salary-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="8354.02"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={error !== null && busy === null}
                className="rounded-[10px] bg-background font-numeric" />
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground">
            {valid ? `≈ ${usd(parsed / 12)} a month, used for every month of ${year}.` : "Spread evenly across the year's 12 months."}
          </div>

          {error && <div role="alert" className="text-xs text-destructive">{error}</div>}

          <DialogFooter>
            <Button type="submit" disabled={busy !== null} className="w-full rounded-[10px] font-semibold sm:w-auto">
              {busy === "save" && <Loader2 className="animate-spin" />}
              Save {year}
            </Button>
          </DialogFooter>
        </form>

        {saved.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-border pt-4">
            <div className="mb-1 text-[10px] tracking-[0.07em] text-muted-foreground uppercase">On file</div>
            {saved.map((row) => (
              <div key={row.year} className="flex items-center gap-3 rounded-lg px-1 py-1">
                <span className="w-12 font-numeric text-[13px] font-semibold text-secondary-foreground">{row.year}</span>
                <span className="flex-1 font-numeric text-[13px] font-bold text-foreground">{usd(row.amount)}</span>
                <Button
                  variant="ghost" size="icon-sm"
                  aria-label={`Remove ${row.year} salary`}
                  disabled={busy !== null}
                  onClick={() => remove(row.year)}
                  className="text-muted-foreground hover:text-destructive">
                  {busy === row.year ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
