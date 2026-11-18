import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import {
  Card, KpiCard, DashboardControls, EmptyState, SectionHeading,
  buildTimeline, bucketValue, bucketLabelsOf, bucketChange,
  type FinAnalytics, type FinGroup, type FinSubSection, type FinLineItem, type FinPoint,
} from "./dashboardKit";
import {
  formatCompact, formatINR, formatKpi, SOURCES_COLOR, GROSS_PROFIT_COLOR, APPLICATION_COLOR,
  SUCCESS_COLOR, DANGER_COLOR, NEUTRAL_COLOR, GRID_LINE_COLOR, AXIS_TEXT_COLOR,
} from "./format";
import { computeDelta, type TrendView } from "./aggregate";
import { keepUpTo } from "./pickedPeriod";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// formatCompact drops the sign (it works on |n|); a cash flow statement lives or
// dies by direction, so wrap it to keep the minus for outflows.
const fmtSigned = (v: number | null | undefined) =>
  v == null ? "—" : (v < 0 ? "−" : "") + formatCompact(v);
const fmtSignedFull = (v: number | null | undefined) =>
  v == null ? "—" : (v < 0 ? "−" : "") + formatINR(Math.abs(v));
// KPI cards auto-scale to the value's natural unit (K/Cr), keeping the outflow sign.
const fmtSignedKpi = (v: number | null | undefined) =>
  v == null ? "—" : (v < 0 ? "−" : "") + formatKpi(Math.abs(v));
const fmtStep = (v: number) => `${v >= 0 ? "+" : "−"}${formatCompact(v)}`;
const signColor = (v: number | null | undefined) =>
  v == null ? NEUTRAL_COLOR : v >= 0 ? SUCCESS_COLOR : DANGER_COLOR;
const lc = (s: string) => s.toLowerCase();

// Sum several period-series into one, aligned by period_end_date (used to derive
// Net Change = A+B+C, and Free Cash Flow = Operating Cash + Capex, per period).
function sumSeries(seriesList: FinPoint[][]): FinPoint[] {
  const byPeriod = new Map<string, FinPoint>();
  for (const series of seriesList) {
    for (const p of series) {
      if (p.amount == null) continue;
      const cur = byPeriod.get(p.period_end_date);
      if (cur) cur.amount = (cur.amount ?? 0) + p.amount;
      else byPeriod.set(p.period_end_date, { ...p });
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.period_end_date.localeCompare(b.period_end_date));
}

const ACTIVITY_ORDER = ["operating_activities", "investing_activities", "financing_activities", "reconciliation"] as const;
const ACTIVITY_ACCENT: Record<string, string> = {
  operating_activities: SOURCES_COLOR,
  investing_activities: GROSS_PROFIT_COLOR,
  financing_activities: APPLICATION_COLOR,
  reconciliation: NEUTRAL_COLOR,
};

// ── How profit becomes cash — Net Profit → Operating Cash, adjusted by the ─────
// sheet's own subtotals (non-cash add-backs, working-capital swings, tax). A
// horizontal level+step list (the approved bridge form), never a vertical waterfall.
function OperatingCashBridge({ rows, period }: { rows: { label: string; value: number; anchor: boolean }[]; period: string }) {
  if (rows.length < 2) return (
    <Card title="How profit becomes cash" note={`Net Profit → Operating Cash · ${period}`}>
      <div className="text-[11px] text-gray-500 py-6">Net Profit and Operating Cash aren't both available this period.</div>
    </Card>
  );
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <Card title="How profit becomes cash" note={`Net Profit adjusted to Operating Cash · ${period}. Add-backs and working-capital swings are the sheet's own subtotals.`}>
      <div className="flex flex-col">
        {rows.map((r, i) => (
          <div key={r.label} className={`flex items-center gap-3 ${r.anchor ? "py-2" : "py-1.5"} ${r.anchor && i > 0 ? "border-t border-gray-100 mt-1" : ""}`}>
            <span className={`w-44 shrink-0 text-[12px] truncate ${r.anchor ? "font-bold text-gray-800" : "text-gray-600"}`} title={r.label}>{r.label}</span>
            <div className={`flex-1 ${r.anchor ? "h-3.5" : "h-2.5"} bg-gray-50 rounded-full overflow-hidden`}>
              <div className="h-full rounded-full" style={{ width: `${(Math.abs(r.value) / maxAbs) * 100}%`, minWidth: 3, background: r.anchor ? SOURCES_COLOR : signColor(r.value), opacity: r.anchor ? 0.9 : 0.75 }} />
            </div>
            <span className={`w-24 shrink-0 text-right text-[12px] tabular-nums ${r.anchor ? "font-bold text-gray-900" : "font-semibold"}`}
              style={r.anchor ? undefined : { color: signColor(r.value) }} title={formatINR(r.value)}>
              {r.anchor ? fmtSigned(r.value) : fmtStep(r.value)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// The sheet prefixes every WC line with "Increase / (Decrease) in" or the
// mirror "(Increase) / Decrease in". That direction is already shown by the
// green/red bars, so strip it for a readable label (full text stays in the
// hover title).
function shortWcLabel(label: string): string {
  return label
    .replace(/^\s*\(?\s*increase\s*\)?\s*\/\s*\(?\s*decrease\s*\)?\s*in\s+/i, "")
    .trim() || label;
}

// ── Working-capital drivers — which items released vs trapped cash this period ─
function WorkingCapitalDrivers({ items, period }: { items: { label: string; value: number }[]; period: string }) {
  if (items.length === 0) return (
    <Card title="Working-capital drivers" note={`Where cash was released or trapped · ${period}`}>
      <div className="text-[11px] text-gray-500 py-6">No working-capital movement this period.</div>
    </Card>
  );
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const sorted = [...items].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return (
    <Card title="Working-capital drivers" note={`Right / green released cash · left / red trapped cash · ${period}`}>
      <div className="flex flex-col gap-1">
        {sorted.map((it) => {
          const pos = it.value >= 0;
          const w = (Math.abs(it.value) / maxAbs) * 100;
          return (
            <div key={it.label} className="flex items-center gap-2 text-[12px]">
              <span className="w-52 shrink-0 text-gray-600 leading-tight" title={it.label}>{shortWcLabel(it.label)}</span>
              <div className="flex-1 flex items-center">
                <div className="w-1/2 flex justify-end">
                  {!pos && <div className="h-3.5 rounded-l-full" style={{ width: `${w}%`, background: DANGER_COLOR, opacity: 0.8 }} />}
                </div>
                <div className="w-px h-4 bg-gray-300" />
                <div className="w-1/2">
                  {pos && <div className="h-3.5 rounded-r-full" style={{ width: `${w}%`, background: SUCCESS_COLOR, opacity: 0.8 }} />}
                </div>
              </div>
              <span className="w-24 shrink-0 text-right font-semibold tabular-nums" style={{ color: signColor(it.value) }} title={formatINR(it.value)}>
                {fmtStep(it.value)}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface GenRow { label: string; "Net Profit": number | null; "Operating Cash": number | null; "Free Cash Flow": number | null }

// ── Cash generation over time — the one trend on the page ─────────────────────
// Free Cash Flow as sign-coloured bars; Net Profit and Operating Cash as lines.
// Reads three linked facts at once: does profit convert to cash (Net Profit vs
// Operating Cash), and what's left after capex (Free Cash Flow).
function CashGenerationCard({ data }: { data: GenRow[] }) {
  return (
    <Card title="Cash generation — over time"
      note="Free Cash Flow (bars, green = positive) with Net Profit and Operating Cash (lines). The gap between the lines is earnings quality; the gap to the bars is capex.">
      {data.length === 0 ? <div className="text-[11px] text-gray-500 py-6">No periods yet.</div> : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
            <YAxis tickFormatter={(v) => fmtSigned(Number(v))} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={70} />
            <ReferenceLine y={0} stroke={AXIS_TEXT_COLOR} />
            <Tooltip formatter={(v: any, n: any) => [fmtSignedFull(Number(v)), n]}
              contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Free Cash Flow" fill={SUCCESS_COLOR} radius={[3, 3, 0, 0]} maxBarSize={40}>
              {data.map((d, i) => <Cell key={i} fill={signColor(d["Free Cash Flow"])} />)}
            </Bar>
            <Line type="monotone" dataKey="Net Profit" stroke={APPLICATION_COLOR} strokeWidth={2} dot={{ r: 2 }} connectNulls />
            <Line type="monotone" dataKey="Operating Cash" stroke={SOURCES_COLOR} strokeWidth={2} dot={{ r: 2 }} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ── The full statement, grouped by activity, mirroring the sheet ─────────────
function StatementTable({ activities, view }: { activities: FinSubSection[]; view: TrendView }) {
  const cols = useMemo(() => {
    const all: FinPoint[] = [];
    for (const sub of activities) {
      for (const it of sub.line_items) all.push(...it.series);
      if (sub.total) all.push(...sub.total.series);
    }
    return [...new Set(buildTimeline(all, "flow", view).map((x) => x.label))].slice(-8);
  }, [activities, view]);

  const bucketOf = (series: FinPoint[]) => new Map(buildTimeline(series, "flow", view).map((x) => [x.label, x.value]));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="border-b-2 border-gray-200">
            <th className="text-left py-2 pr-3 font-semibold text-gray-500 sticky left-0 bg-white">Particulars</th>
            {cols.map((c) => (
              <th key={c} className="text-right py-2 px-3 font-semibold text-gray-500 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {activities.map((sub) => (
            <Fragment key={sub.key ?? "recon"}>
              <tr className="border-b border-gray-100 bg-[#FAF7F1]">
                <td colSpan={cols.length + 1} className="py-1.5 pr-3 pl-3 font-bold text-gray-800 sticky left-0 bg-[#FAF7F1] uppercase tracking-wide text-[11px]">
                  {sub.label ?? "Net Change & Cash Position"}
                </td>
              </tr>
              {sub.line_items.map((it) => {
                const m = bucketOf(it.series);
                return (
                  <tr key={it.line_key} className="border-b border-gray-100">
                    <td className="py-2 pr-3 pl-4 text-gray-600 sticky left-0 bg-white">{it.line_label}</td>
                    {cols.map((c) => {
                      const v = m.get(c) ?? null;
                      return <td key={c} className="py-2 px-3 text-right whitespace-nowrap tabular-nums" style={{ color: v == null ? undefined : signColor(v) }}>{v != null ? fmtSigned(v) : "—"}</td>;
                    })}
                  </tr>
                );
              })}
              {sub.total && (() => {
                const m = bucketOf(sub.total.series);
                return (
                  <tr className="border-b-2 border-gray-200">
                    <td className="py-2 pr-3 pl-3 font-bold text-gray-800 sticky left-0 bg-white">{sub.total.line_label}</td>
                    {cols.map((c) => {
                      const v = m.get(c) ?? null;
                      return <td key={c} className="py-2 px-3 text-right whitespace-nowrap font-bold tabular-nums text-gray-900" title={v != null ? formatINR(v) : ""}>{v != null ? fmtSigned(v) : "—"}</td>;
                    })}
                  </tr>
                );
              })()}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CashFlowView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
  const { token } = useAuth();
  const [data, setData] = useState<FinAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=cash_flow`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load Cash Flow");
        return r.json();
      })
      .then((d: FinAnalytics) => { if (alive) setData(d); })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [sheetSourceId, token, refreshNonce]);

  const group: FinGroup | null = useMemo(() => data?.groups.find((g) => g.section_key === "cash_flow_statement") ?? null, [data]);
  const subOf = (key: string) => group?.sub_sections.find((s) => s.key === key) ?? null;

  const op = subOf("operating_activities");
  const inv = subOf("investing_activities");
  const fin = subOf("financing_activities");

  const opSeries = op?.total?.series ?? [];
  const invSeries = inv?.total?.series ?? [];
  const finSeries = fin?.total?.series ?? [];
  const netSeries = useMemo(() => sumSeries([opSeries, invSeries, finSeries]), [opSeries, invSeries, finSeries]);

  const activities = useMemo(
    () => ACTIVITY_ORDER.map((k) => subOf(k)).filter((s): s is FinSubSection => !!s),
    [group],
  );

  // Named rows inside the operating section (labels are the sheet's standard
  // cash-flow-statement text). Working-capital items are the line items between
  // the two operating subtotals.
  const opItems = op?.line_items ?? [];
  const netProfitItem = opItems.find((it) => lc(it.line_label).includes("net profit"));
  const nonCashSub = opItems.find((it) => lc(it.line_label).includes("sub-total") && lc(it.line_label).includes("non-cash"));
  const wcSub = opItems.find((it) => lc(it.line_label).includes("sub-total") && lc(it.line_label).includes("working capital"));
  const taxItem = opItems.find((it) => lc(it.line_label).includes("direct tax"));
  const wcItems: FinLineItem[] = (nonCashSub && wcSub)
    ? opItems.filter((it) => (it.item_no ?? 0) > (nonCashSub.item_no ?? 0) && (it.item_no ?? 0) < (wcSub.item_no ?? 0))
    : [];
  // Capex = Purchase of Fixed Assets (already stored negative). FCF = OCF + capex.
  const capexItem = (inv?.line_items ?? []).find((it) => lc(it.line_label).includes("purchase of fixed assets"));
  const fcfSeries = useMemo(() => sumSeries([opSeries, capexItem?.series ?? []]), [opSeries, capexItem]);

  const bucketLabels = useMemo(() => bucketLabelsOf(netSeries, "flow", view), [netSeries, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  const bv = (s?: FinPoint[]) => (s ? bucketValue(s, "flow", view, effBucket) : null);
  const opVal = bv(opSeries);
  const invVal = bv(invSeries);
  const finVal = bv(finSeries);
  const netVal = bv(netSeries);
  const fcfVal = bv(fcfSeries);
  const netChange = bucketChange(netSeries, "flow", view, effBucket);
  const netDelta = computeDelta(netChange.value, netChange.prevValue);

  // Operating cash bridge rows (anchors = Net Profit & Operating Cash; steps = the
  // sheet's own subtotals), and the working-capital driver bars — all at effBucket.
  const bridgeRows: { label: string; value: number; anchor: boolean }[] = [];
  const np = bv(netProfitItem?.series); if (np != null) bridgeRows.push({ label: "Net Profit / (Loss)", value: np, anchor: true });
  const nc = bv(nonCashSub?.series); if (nc != null) bridgeRows.push({ label: "Non-cash adjustments", value: nc, anchor: false });
  const wc = bv(wcSub?.series); if (wc != null) bridgeRows.push({ label: "Working-capital changes", value: wc, anchor: false });
  const tax = bv(taxItem?.series); if (tax != null && tax !== 0) bridgeRows.push({ label: "Taxes paid", value: tax, anchor: false });
  if (opVal != null) bridgeRows.push({ label: "Operating Cash Flow", value: opVal, anchor: true });

  const wcDrivers = wcItems
    .map((it) => ({ label: it.line_label, value: bv(it.series) }))
    .filter((d): d is { label: string; value: number } => d.value != null && d.value !== 0);

  const genData: GenRow[] = useMemo(() => {
    const npM = new Map(buildTimeline(netProfitItem?.series ?? [], "flow", view).map((x) => [x.label, x.value]));
    const ocM = new Map(buildTimeline(opSeries, "flow", view).map((x) => [x.label, x.value]));
    const fcM = new Map(buildTimeline(fcfSeries, "flow", view).map((x) => [x.label, x.value]));
    // The chart ends at the picked period, not at the last column in the sheet.
    return bucketLabels.filter((l) => keepUpTo(l, effBucket)).map((l) => ({
      label: l,
      "Net Profit": npM.get(l) ?? null,
      "Operating Cash": ocM.get(l) ?? null,
      "Free Cash Flow": fcM.get(l) ?? null,
    }));
  }, [netProfitItem, opSeries, fcfSeries, bucketLabels, view, effBucket]);

  const hasData = activities.length > 0 && (data?.periods.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      {loading && <div className="text-sm text-gray-500 py-10 text-center">Loading Cash Flow…</div>}
      {error && <EmptyState>{error}</EmptyState>}

      {!loading && !error && hasData && (
        <>
          <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />

          <SectionHeading>Cash Flow — {effBucket}</SectionHeading>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <KpiCard label="Operating (A)" value={fmtSignedKpi(opVal)} accent={ACTIVITY_ACCENT.operating_activities} exact={opVal != null ? formatINR(opVal) : undefined} />
            <KpiCard label="Investing (B)" value={fmtSignedKpi(invVal)} accent={ACTIVITY_ACCENT.investing_activities} exact={invVal != null ? formatINR(invVal) : undefined} />
            <KpiCard label="Financing (C)" value={fmtSignedKpi(finVal)} accent={ACTIVITY_ACCENT.financing_activities} exact={finVal != null ? formatINR(finVal) : undefined} />
            <KpiCard label="Free Cash Flow" value={fmtSignedKpi(fcfVal)} accent={signColor(fcfVal)} exact={fcfVal != null ? formatINR(fcfVal) : undefined} />
            <KpiCard label="Net Change in Cash" value={fmtSignedKpi(netVal)} accent={signColor(netVal)}
              deltaPct={netDelta.pct} deltaPeriod={netChange.prevLabel ? `vs ${netChange.prevLabel}` : null}
              exact={netVal != null ? formatINR(netVal) : undefined} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <OperatingCashBridge rows={bridgeRows} period={effBucket} />
            <WorkingCapitalDrivers items={wcDrivers} period={effBucket} />
          </div>

          <CashGenerationCard data={genData} />

          <Card title="Cash Flow Statement — detail" note="Grouped by activity, mirroring the sheet. Outflows shown negative; subtotals and activity nets are the sheet's own.">
            <StatementTable activities={activities} view={view} />
          </Card>
        </>
      )}

      {!loading && !error && !hasData && (
        <EmptyState>
          <div className="font-semibold text-gray-500 mb-1">No Cash Flow data yet</div>
          The Cash Flow Statement (section 15) is empty for this company. It will populate on the next master sync once the sheet tab has data.
        </EmptyState>
      )}
    </div>
  );
}
