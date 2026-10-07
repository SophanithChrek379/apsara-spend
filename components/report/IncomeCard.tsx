"use client";

// ─── Income vs spending ───────────────────────────────────────────────────────
//
// The report's salary comparison, behind a Face ID lock (lib/biometric-lock.ts).
//
// Locked is the default, and while locked the salary does not exist on the
// client at all: it is fetched from /api/income only after the biometric check
// passes, kept in this component's state alone (never the ledger cache, never
// localStorage), and dropped again the moment the card locks. The placeholders
// are fixed dots rather than a blurred real figure — a blur still puts the
// number in the DOM.
//
// It re-locks on its own when the app goes to the background and, because the
// report sheet unmounts its content on close, every time the report closes.

import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Loader2, Lock, LockOpen, Pencil, ScanFace, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { SalaryDialog } from "@/components/report/SalaryDialog";
import {
  BiometricError, hasBiometricLock, isBiometricAvailable, registerBiometricLock,
  resetBiometricLock, unlockWithBiometric,
} from "@/lib/biometric-lock";
import { buildIncomeComparison } from "@/lib/income";
import { listIncome, putIncome, removeIncome } from "@/lib/ledger/api";
import type { ReportData } from "@/lib/report";
import type { AnnualIncome } from "@/lib/types";
import { cn } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1];

const COMPARE_CONFIG = {
  income: { label: "Earned", color: "var(--ui-chart-4)" },
  spent:  { label: "Spent",  color: "var(--ui-primary)" },
} satisfies ChartConfig;

const HIDDEN = "••••••";

type LockState =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "locked"; registered: boolean; busy: boolean; error: string | null }
  | { kind: "loading" }
  | { kind: "unlocked"; income: AnnualIncome }
  | { kind: "failed" };

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-muted/60 px-3 py-2.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn(
        "truncate font-display text-[17px] leading-none font-extrabold tracking-[-0.02em] tabular-nums",
        tone === "good" ? "text-chart-4" : tone === "bad" ? "text-destructive" : "text-foreground",
      )}>
        {value}
      </span>
    </div>
  );
}

export function IncomeCard({ report, fmt }: {
  report: Pick<ReportData, "months" | "txs">;
  fmt: (usd: number) => string;
}) {
  const [state, setState] = React.useState<LockState>({ kind: "checking" });
  const [editing, setEditing] = React.useState(false);

  const lock = React.useCallback(() => {
    setEditing(false);
    setState({ kind: "locked", registered: hasBiometricLock(), busy: false, error: null });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    isBiometricAvailable().then((ok) => {
      if (cancelled) return;
      if (ok) lock();
      else setState({ kind: "unavailable" });
    });
    return () => { cancelled = true; };
  }, [lock]);

  // Leaving the app re-locks — coming back to it should ask again.
  React.useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") lock(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [lock]);

  const unlock = async () => {
    if (state.kind !== "locked") return;
    setState({ ...state, busy: true, error: null });
    try {
      if (state.registered) await unlockWithBiometric();
      else await registerBiometricLock();
    } catch (err) {
      setState({
        kind: "locked", registered: hasBiometricLock(), busy: false,
        error: err instanceof BiometricError ? err.message : "Face ID failed.",
      });
      return;
    }
    setState({ kind: "loading" });
    try {
      setState({ kind: "unlocked", income: await listIncome() });
    } catch {
      setState({ kind: "failed" });
    }
  };

  const save = async (year: number, amount: number) => {
    const saved = await putIncome(year, amount);
    setState((s) => s.kind === "unlocked"
      ? { kind: "unlocked", income: { ...s.income, [saved.year]: saved.amount } }
      : s);
    setEditing(false);
  };

  const remove = async (year: number) => {
    await removeIncome(year);
    setState((s) => {
      if (s.kind !== "unlocked") return s;
      const { [year]: _gone, ...rest } = s.income;
      return { kind: "unlocked", income: rest };
    });
  };

  const header = (action?: React.ReactNode, description?: string) => (
    <CardHeader className="gap-1 px-5">
      <CardTitle className="font-display text-[15px] font-bold tracking-[-0.01em]">
        Income vs spending
      </CardTitle>
      <CardDescription className="text-xs leading-[1.4]">
        {description ?? "Your salary stays hidden until you verify it's you."}
      </CardDescription>
      {action && <CardAction>{action}</CardAction>}
    </CardHeader>
  );

  const shell = "gap-4 rounded-2xl border-border bg-background py-5 shadow-none";

  // ── Locked / unavailable / loading ────────────────────────────────────────
  if (state.kind !== "unlocked") {
    const busy = state.kind === "checking" || state.kind === "loading" || (state.kind === "locked" && state.busy);
    return (
      <Card className={shell}>
        {header(
          <Badge variant="secondary" className="gap-1">
            <Lock className="size-3" /> Locked
          </Badge>,
        )}
        <CardContent className="flex flex-col gap-4 px-5">
          <div aria-hidden className="grid grid-cols-3 gap-2 select-none">
            <Stat label="Earned" value={HIDDEN} />
            <Stat label="Spent" value={HIDDEN} />
            <Stat label="Saved" value={HIDDEN} />
          </div>

          {state.kind === "unavailable" ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-3 text-xs leading-[1.5] text-muted-foreground">
              This browser has no Face ID, Touch ID or device unlock, so your salary stays hidden here.
              Open the app on your phone to view it.
            </div>
          ) : state.kind === "failed" ? (
            <div className="flex flex-col gap-2">
              <div role="alert" className="text-xs text-destructive">Couldn&apos;t load your salary.</div>
              <Button variant="secondary" onClick={lock} className="w-full rounded-[10px]">Try again</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Button
                onClick={unlock}
                disabled={busy}
                className="h-11 w-full rounded-[10px] font-semibold">
                {busy ? <Loader2 className="animate-spin" /> : <ScanFace />}
                {state.kind === "locked" && !state.registered ? "Set up Face ID to view" : "Unlock with Face ID"}
              </Button>
              {state.kind === "locked" && state.error && (
                <div role="alert" className="text-center text-xs text-destructive">{state.error}</div>
              )}
              {state.kind === "locked" && state.registered && state.error && (
                <Button
                  variant="link" size="sm"
                  onClick={() => { resetBiometricLock(); lock(); }}
                  className="h-auto self-center text-[11px] text-muted-foreground">
                  Set up Face ID again on this device
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Unlocked ──────────────────────────────────────────────────────────────
  const c = buildIncomeComparison(report, state.income);
  const hasIncome = c.coveredMonths > 0;
  const overspent = c.saved < 0;
  const raised    = (c.salaryChangePct ?? 0) >= 0;

  const actions = (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="Edit salary" onClick={() => setEditing(true)}
        className="text-muted-foreground">
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Lock salary" onClick={lock}
        className="text-muted-foreground">
        <LockOpen />
      </Button>
    </div>
  );

  const coverage =
    !hasIncome ? null
    : c.missingYears.length > 0
      ? `No salary on file for ${c.missingYears.join(", ")} — those months are left out. Add it with the pencil.`
      : c.coveredMonths < report.months.length
        ? `Counting the ${c.coveredMonths} ${c.coveredMonths === 1 ? "month" : "months"} so far — months still ahead earn nothing yet.`
        : `Salary spread evenly: ${fmt((c.salary ?? 0) / 12)} a month.`;

  return (
    <Card className={cn(shell, "animate-in fade-in duration-300")}>
      {header(actions, hasIncome ? "Like for like: only months you've been paid for." : "Add your salary to compare it with your spending.")}
      <CardContent className="flex flex-col gap-4 px-5">
        {/* Annual salary for the report's year, with the raise vs last year. */}
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Annual salary {c.salaryYear}</span>
            <span className="font-display text-[26px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">
              {c.salary !== null ? fmt(c.salary) : "Not set"}
            </span>
          </div>
          {c.salaryChangePct !== null && (
            <Badge
              variant="outline"
              className={cn(
                "gap-1 font-numeric",
                raised ? "border-chart-4/30 bg-chart-4/10 text-chart-4" : "border-destructive/30 bg-destructive/10 text-destructive",
              )}>
              {raised ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {raised ? "+" : ""}{c.salaryChangePct.toFixed(1)}% vs {c.salaryYear - 1}
            </Badge>
          )}
        </div>

        {!hasIncome ? (
          <Button variant="secondary" onClick={() => setEditing(true)} className="w-full rounded-[10px] font-semibold">
            Add your {c.salaryYear} salary
          </Button>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Earned" value={fmt(c.earned)} />
              <Stat label="Spent" value={fmt(c.spent)} />
              <Stat label={overspent ? "Overspent" : "Saved"} value={fmt(Math.abs(c.saved))} tone={overspent ? "bad" : "good"} />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Share of income spent</span>
                <span className={cn("font-numeric font-bold", overspent ? "text-destructive" : "text-foreground")}>
                  {Math.round(c.spentPct ?? 0)}%
                </span>
              </div>
              <Progress
                value={Math.min(c.spentPct ?? 0, 100)}
                aria-label="Share of income spent"
                className={cn(
                  "h-2.5 bg-chart-4/20",
                  overspent ? "*:data-[slot=progress-indicator]:bg-destructive" : "*:data-[slot=progress-indicator]:bg-primary",
                )} />
              <div className="text-[11px] text-muted-foreground">
                {overspent
                  ? `You spent ${fmt(-c.saved)} more than you earned.`
                  : `Savings rate ${Math.round(c.savingsRate ?? 0)}% — you kept ${fmt(c.saved)} of ${fmt(c.earned)}.`}
              </div>
            </div>

            {report.months.length > 1 && (
              <ChartContainer config={COMPARE_CONFIG} className="-mx-2 aspect-auto h-[190px] w-[calc(100%+1rem)]">
                <BarChart data={c.series} margin={{ left: 4, right: 4, top: 8 }} barGap={2}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="key" tickLine={false} axisLine={false} tickMargin={8}
                    minTickGap={12} tickFormatter={monthName} />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(_, payload) => {
                          const key = String(payload?.[0]?.payload?.key ?? "");
                          return `${monthName(key)} ${key.slice(0, 4)}`;
                        }}
                        formatter={(value, name) => (
                          <span className="flex w-full justify-between gap-4">
                            <span className="text-muted-foreground">
                              {COMPARE_CONFIG[name as keyof typeof COMPARE_CONFIG]?.label ?? name}
                            </span>
                            <span className="font-numeric font-semibold text-foreground">{fmt(Number(value))}</span>
                          </span>
                        )} />
                    } />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="income" fill="var(--color-income)" radius={3} />
                  <Bar dataKey="spent" fill="var(--color-spent)" radius={3} />
                </BarChart>
              </ChartContainer>
            )}
          </>
        )}
      </CardContent>
      {coverage && (
        <CardFooter className="px-5 text-[11px] leading-[1.45] text-muted-foreground">{coverage}</CardFooter>
      )}

      <SalaryDialog
        open={editing}
        onOpenChange={setEditing}
        income={state.income}
        defaultYear={c.salaryYear}
        onSave={save}
        onDelete={remove} />
    </Card>
  );
}
