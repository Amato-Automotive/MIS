// BUDGET tab — finance's budget against what the company actually did.
//
// The sheet's Budget block (below Cash Flow) holds three budgets: a P&L ladder,
// a cash-flow plan and sale units. It carries no actuals, so each line is
// compared with the sheet's own reported figures — Sales Accounts, Gross Margin,
// PBITDA, PAT, closing cash, §7 units — matched server-side; the "actual from"
// note under each line says which.
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { useAuth } from "@/context/AuthContext";
import {
  Card, DashboardControls, EmptyState, SectionHeading, bucketLabelsOf, mergedLabels, buildTimeline,
  type FinAnalytics, type FinLineItem, type FinPoint,
} from "./dashboardKit";
import type { TrendView } from "./aggregate";
import {
  formatINR, formatKpi, GRID_LINE_COLOR, AXIS_TEXT_COLOR, SUCCESS_COLOR, DANGER_COLOR, REVENUE_COLOR,
  NEUTRAL_COLOR, SOURCES_COLOR, APPLICATION_COLOR,
} from "./format";
import { cashLineValue, compare, flowReading, isCostLine, slugOf, type VarianceReading } from "./budgetMath";
import { BarRow, TableCard, Th, TipBox, fmtMoney, rowBg } from "./all-companies/shared";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const BUDGET_COLOR = "#14161A"; // the plan: a dark dashed line, so the actual bars stay the subject

type BudgetAnalytics = FinAnalytics & { actuals?: Record<string, { basis: string; series: FinPoint[] }> };

const fmtQty = (n: number | null) => (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
const fmtPctSigned = (f: number | null) => (f == null ? "—" : `${f > 0 ? "+" : f < 0 ? "−" : ""}${Math.abs(f * 100).toFixed(1)}%`);
const fmtAch = (f: number | null) => (f == null ? "—" : `${Math.round(f * 100)}%`);
export const tone = (r: VarianceReading) => (r.favourable == null ? NEUTRAL_COLOR : r.favourable ? SUCCESS_COLOR : DANGER_COLOR);

// The sheet's own label, minus its one typo — "Revanue/Income" would sit in the
// headline tile otherwise. Keys keep the sheet's spelling.
export const displayLabel = (it: FinLineItem) => (slugOf(it.line_key) === "revanue_income" ? "Revenue / Income" : it.line_label.trim());

const HEADLINE = ["revanue_income", "revenue_income", "gross_profit", "pbitda", "pat"];

/** Actual against budget as a bar: the fill is the actual, the tick is 100%. */
export function AchievementBar({ r }: { r: VarianceReading }) {
  if (r.achievement == null) return <span className="text-[11px] text-gray-400">—</span>;
  const scale = Math.max(1.2, r.achievement);
  return (
    <div className="flex items-center gap-2 min-w-[8rem]">
      <div className="relative h-2 flex-1 rounded-full bg-[#F3EEE4]">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(r.achievement / scale, 1) * 100}%`, background: tone(r) }} />
        <div className="absolute -top-1 -bottom-1 w-px bg-gray-700" style={{ left: `${(1 / scale) * 100}%` }} />
      </div>
      <span className="text-[11px] font-bold tabular-nums w-10 text-right" style={{ color: tone(r) }}>{fmtAch(r.achievement)}</span>
    </div>
  );
}

function BudgetTile({ label, r }: { label: string; r: VarianceReading }) {
  return (
    <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-4 overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: tone(r) }} />
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label} · actual</div>
      <div className="text-2xl font-bold text-gray-800 tracking-tight mt-1" title={r.actual != null ? formatINR(r.actual) : undefined}>
        {r.actual != null ? formatKpi(r.actual) : "—"}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5" title={r.budget != null ? formatINR(r.budget) : undefined}>
        Budget {r.budget != null ? formatKpi(r.budget) : "—"}
        {r.variance != null && (
          <span className="font-semibold" style={{ color: tone(r) }}> · {r.variance >= 0 ? "+" : "−"}{formatKpi(Math.abs(r.variance))}</span>
        )}
      </div>
      <div className="mt-2"><AchievementBar r={r} /></div>
    </div>
  );
}

export default function BudgetView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
  const { token } = useAuth();
  const [data, setData] = useState<BudgetAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState<string>("");
  const [trendKey, setTrendKey] = useState<string>("");

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=budget`, {
      headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load the budget");
        return r.json();
      })
      .then((d: BudgetAnalytics) => setData(d))
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [sheetSourceId, token, refreshNonce]);

  const group = data?.groups.find((g) => g.section_key === "budget");
  const items = (key: string) => group?.sub_sections.find((s) => s.key === key)?.line_items ?? [];
  const pnl = items("pnl");
  const cash = items("cash_flow");
  const units = items("units");
  const actuals = data?.actuals ?? {};
  const actualOf = (it: FinLineItem) => actuals[it.line_key];

  // The picker offers the periods the BUDGET covers — comparing against a month
  // finance never budgeted would read as a 0% achievement.
  const budgetPoints = useMemo(() => [...pnl, ...cash, ...units].flatMap((it) => it.series), [pnl, cash, units]);
  const bucketLabels = useMemo(() => bucketLabelsOf(budgetPoints, "flow", view), [budgetPoints, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  const pnlRows = pnl.map((it) => ({ it, r: flowReading(it.series, actualOf(it)?.series, it.line_key, view, effBucket) }));
  const revenueRow = pnlRows.find((x) => ["revanue_income", "revenue_income"].includes(slugOf(x.it.line_key)));
  const headline = HEADLINE.map((slug) => pnlRows.find((x) => slugOf(x.it.line_key) === slug)).filter(Boolean) as typeof pnlRows;

  const trendItem = pnl.find((it) => it.line_key === trendKey) ?? revenueRow?.it ?? pnl[0];
  const trend = useMemo(() => {
    if (!trendItem) return [];
    const b = buildTimeline(trendItem.series, "flow", view);
    const a = buildTimeline(data?.actuals?.[trendItem.line_key]?.series ?? [], "flow", view);
    const bm = new Map(b.map((x) => [x.label, x.value]));
    const am = new Map(a.map((x) => [x.label, x.value]));
    // Only the periods the budget covers, in date order.
    return mergedLabels([b]).map((label) => ({ label, budget: bm.get(label) ?? null, actual: am.get(label) ?? null }));
  }, [trendItem, view, data]);

  const cashLabels = useMemo(() => bucketLabelsOf(cash.flatMap((it) => it.series), "flow", view), [cash, view]);

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading the budget…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (!group || budgetPoints.every((p) => p.amount == null)) {
    return (
      <EmptyState>
        <div className="font-semibold text-gray-600 mb-1">No budget for this company yet</div>
        Finance adds a <b>Budget</b> block (Budget / Actual / Variance, Budget Cash Flow, Budget Sale Units) below Cash Flow in
        the company's tab. Once it's in the sheet and synced, the comparison shows here.
      </EmptyState>
    );
  }

  const share = (v: number | null, base: number | null) => (v == null || base == null || base <= 0 ? null : v / base);

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />

      {pnl.length > 0 && (
        <>
          <SectionHeading accent={REVENUE_COLOR}>Budget vs Actual · {effBucket || "—"}</SectionHeading>
          {headline.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {headline.slice(0, 4).map(({ it, r }) => <BudgetTile key={it.line_key} label={displayLabel(it)} r={r} />)}
            </div>
          )}

          <TableCard footer={
            <>Budget is finance's; actual is what the sheet reports for {effBucket} (the line under each name says which row).
              Variance = actual − budget. Green is favourable — above budget for income and profit, <b>below</b> it for costs.
              Achievement = actual ÷ budget; the tick marks 100%. A quarter or year adds up its months.</>
          }>
            <thead>
              <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
                <Th align="left">Line</Th>
                <Th>Budget</Th>
                <Th>Actual</Th>
                <Th>Variance</Th>
                <Th>Variance %</Th>
                <Th align="left">Achievement</Th>
              </tr>
            </thead>
            <tbody>
              {pnlRows.map(({ it, r }, i) => {
                const actual = actualOf(it);
                const bShare = share(r.budget, revenueRow?.r.budget ?? null);
                const aShare = share(r.actual, revenueRow?.r.actual ?? null);
                const isRevenue = it === revenueRow?.it;
                return (
                  <tr key={it.line_key} className={rowBg(i)}>
                    <td className="px-4 py-3">
                      <div className="text-[13px] font-semibold text-gray-800">{displayLabel(it)}</div>
                      <div className="text-[11px] text-gray-500">{actual ? `Actual: ${actual.basis}` : "No matching actual in the sheet"}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <div className="text-[13px] font-semibold text-gray-800" title={r.budget != null ? formatINR(r.budget) : undefined}>{fmtMoney(r.budget)}</div>
                      {!isRevenue && bShare != null && <div className="text-[11px] text-gray-500">{(bShare * 100).toFixed(1)}% of revenue</div>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <div className="text-[13px] font-semibold text-gray-800" title={r.actual != null ? formatINR(r.actual) : undefined}>{fmtMoney(r.actual)}</div>
                      {!isRevenue && aShare != null && <div className="text-[11px] text-gray-500">{(aShare * 100).toFixed(1)}% of revenue</div>}
                    </td>
                    <td className="px-4 py-3 text-right text-[13px] font-bold tabular-nums" style={{ color: tone(r) }}>
                      {r.variance == null ? "—" : `${r.variance >= 0 ? "+" : "−"}${fmtMoney(Math.abs(r.variance))}`}
                    </td>
                    <td className="px-4 py-3 text-right text-[12px] font-semibold tabular-nums" style={{ color: tone(r) }}>{fmtPctSigned(r.variancePct)}</td>
                    <td className="px-4 py-3"><AchievementBar r={r} /></td>
                  </tr>
                );
              })}
            </tbody>
          </TableCard>

          {trendItem && trend.length > 0 && (
            <Card title="Budget vs actual over time"
              note={`${displayLabel(trendItem)} by ${view === "monthly" ? "month" : view === "quarterly" ? "quarter" : "year"} — bars are the actual, the dashed line is the budget.`}
              right={
                <select value={trendItem.line_key} onChange={(e) => setTrendKey(e.target.value)}
                  className="no-print text-[11px] font-semibold text-gray-700 bg-white border border-[#EAE3D6] rounded-lg px-2 py-1">
                  {pnl.map((it) => <option key={it.line_key} value={it.line_key}>{displayLabel(it)}</option>)}
                </select>
              }>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={trend} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
                  <YAxis tickFormatter={(v) => fmtMoney(v)} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={72} />
                  <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }}
                    content={(p: any) => {
                      const row = p?.active ? p.payload?.[0]?.payload : undefined;
                      if (!row) return null;
                      const r = compare(row.budget, row.actual, isCostLine(trendItem.line_key));
                      return (
                        <TipBox title={`${displayLabel(trendItem)} · ${row.label}`}>
                          <div className="flex justify-between gap-4"><span className="text-gray-600">Actual</span><span className="tabular-nums">{fmtMoney(r.actual)}</span></div>
                          <div className="flex justify-between gap-4"><span className="text-gray-600">Budget</span><span className="tabular-nums">{fmtMoney(r.budget)}</span></div>
                          <div className="flex justify-between gap-4 font-semibold" style={{ color: tone(r) }}>
                            <span>Achievement</span><span className="tabular-nums">{fmtAch(r.achievement)}</span>
                          </div>
                        </TipBox>
                      );
                    }} />
                  <Bar dataKey="actual" name="Actual" fill={REVENUE_COLOR} radius={[3, 3, 0, 0]} maxBarSize={40} />
                  <Line dataKey="budget" name="Budget" stroke={BUDGET_COLOR} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>
      )}

      {units.length > 0 && (
        <>
          <SectionHeading accent={SOURCES_COLOR}>Sale Units · budget vs actual · {effBucket || "—"}</SectionHeading>
          <Card title="Units sold against budget"
            note="Each product's actual sales units (§7 Units) against finance's budgeted units; the tick marks the budget.">
            <div className="flex flex-col gap-3 mt-1">
              {units.map((it) => {
                const r = flowReading(it.series, actualOf(it)?.series, it.line_key, view, effBucket);
                const scale = Math.max(r.budget ?? 0, r.actual ?? 0) * 1.1 || 1;
                return (
                  <BarRow key={it.line_key} name={it.line_label.trim()}
                    value={<>{fmtQty(r.actual)} <span className="text-gray-500 font-medium">of {fmtQty(r.budget)}</span>
                      {r.achievement != null && <span style={{ color: tone(r) }}> · {fmtAch(r.achievement)}</span>}</>}>
                    <div className="relative h-3 rounded-full bg-[#F3EEE4]">
                      {r.actual != null && (
                        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(Math.max(0, r.actual) / scale) * 100}%`, background: tone(r) }} />
                      )}
                      {r.budget != null && <div className="absolute -top-1 -bottom-1 w-0.5 bg-gray-800" style={{ left: `${(r.budget / scale) * 100}%` }} />}
                    </div>
                  </BarRow>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-500 mt-4">Products with no budgeted units in the sheet (blank rows) are not shown.</p>
          </Card>
        </>
      )}

      {cash.length > 0 && cashLabels.length > 0 && (
        <>
          <SectionHeading accent={APPLICATION_COLOR}>Cash Flow Budget</SectionHeading>
          <TableCard footer={
            <>Opening cash is the period's first month, closing cash its last; inflow, outflow and net flow add up the months.
              Rows are as finance writes them in the sheet — lines named “(Actual)” are finance's own actuals, the rest are the plan.
              The highlighted column is {effBucket}.</>
          }>
            <thead>
              <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
                <Th align="left">Line</Th>
                {cashLabels.map((l) => <Th key={l} className={l === effBucket ? "bg-[#F3EEE4]" : ""}>{l}</Th>)}
              </tr>
            </thead>
            <tbody>
              {cash.flatMap((it) => {
                const actual = actualOf(it);
                // Finance now types actuals into the block themselves and marks the row
                // "(Actual)" — a BUDGET tag beside it would contradict its own name.
                const label = it.line_label.trim();
                const rows = [{ key: it.line_key, label, series: it.series, sub: /\(\s*actual\s*\)/i.test(label) ? null : "Budget" }];
                if (actual) rows.push({ key: `${it.line_key}#actual`, label, series: actual.series, sub: "Actual" });
                return rows;
              }).map((row, i) => (
                <tr key={row.key} className={rowBg(i)}>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className="text-[13px] font-semibold text-gray-800">{row.label}</span>
                    {row.sub && (
                      <span className={`ml-2 text-[10px] font-bold uppercase tracking-wider ${row.sub === "Actual" ? "text-gray-700" : "text-gray-500"}`}>{row.sub}</span>
                    )}
                  </td>
                  {cashLabels.map((l) => {
                    const v = cashLineValue(row.series, row.key.replace("#actual", ""), view, l);
                    return (
                      <td key={l} className={`px-4 py-2.5 text-right text-[13px] tabular-nums ${l === effBucket ? "bg-[#F3EEE4]/60" : ""} ${v == null ? "text-gray-400" : "text-gray-800 font-semibold"}`}
                        title={v != null ? formatINR(v) : undefined}>
                        {fmtMoney(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </TableCard>
        </>
      )}
    </div>
  );
}
