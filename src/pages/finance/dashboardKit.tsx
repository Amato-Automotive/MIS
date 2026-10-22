// Shared building blocks for the Finance v2 dashboards (Balance Sheet / P&L /
// Plant Ops). These consume the generic analytics envelope the v2 backend
// returns ({ statement, kind, kpis, groups, periods }) and render it with the
// warm "material" design tokens from format.ts.
//
// Visualization principle (per the user): one fact, one well-labelled chart —
// but every DIFFERENT fact gets the form that fits it. So a section shows its
// current mix as a donut, how that mix shifts over time as a stacked area, the
// numbers + each line's mini-trend as a sparkline table, and what moved most as
// a movers list — four different facts, never the same number replotted.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ResponsiveContainer, ComposedChart, Area, Bar, BarChart, Line, LineChart,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import {
  formatCompact, formatINR, formatPct, formatShare, GRID_LINE_COLOR, AXIS_TEXT_COLOR,
  SUCCESS_COLOR, DANGER_COLOR, NEUTRAL_COLOR, SOURCES_COLOR, REVENUE_COLOR,
  GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, APPLICATION_COLOR,
} from "./format";
import { buildColorMap, computeDelta, type TrendView } from "./aggregate";

// ── Analytics envelope types (v2) ────────────────────────────────────────────
export interface FinPoint {
  period_start_date: string;
  period_end_date: string;
  period_type: "monthly" | "annual";
  amount: number | null;
  percent: number | null;
}
export interface FinLineItem {
  line_key: string;
  line_label: string;
  item_no: number | null;
  entity_type: string;
  parent_key: string | null;
  series: FinPoint[];
}
export interface FinSubSection {
  key: string | null;
  label: string | null;
  line_items: FinLineItem[];
  total: FinLineItem | null;
}
export interface FinGroup {
  section_key: string;
  section_label: string;
  sub_sections: FinSubSection[];
}
export interface FinPeriod {
  period_start_date: string;
  period_end_date: string;
  period_type: "monthly" | "annual";
}
export interface RatioPoint { period_end_date: string; period_type: "monthly" | "annual"; amount: number | null; }
export interface RatioItem { line_key: string; line_label: string; item_no: number | null; series: RatioPoint[]; }
export interface RatioCat { key: string; label: string; items: RatioItem[]; }
export interface ReconTie {
  label: string;
  left: { name: string; value: number };
  right: { name: string; value: number };
  delta: number; matches: boolean; period: string;
}
export interface FinAnalytics {
  statement: string;
  kind: "stock" | "flow";
  kpis: Record<string, any>;
  groups: FinGroup[];
  periods: FinPeriod[];
  ratios?: RatioCat[];
  reconciliation?: ReconTie[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Period + timeline helpers ────────────────────────────────────────────────
export function periodLabel(p: { period_end_date: string; period_type: string }): string {
  const d = new Date(p.period_end_date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (p.period_type === "annual") return `FY ${String(y - 1).slice(2)}-${String(y).slice(2)}`;
  return `${MONTHS[m]} ${y}`;
}

function fyOf(d: Date) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return m >= 4 ? y : y - 1;
}

// Collapse a mixed monthly+annual series onto a chosen granularity WITHOUT
// double counting: monthly view shows months; quarterly buckets months into
// Indian-FY quarters; yearly prefers aggregating the FY's months when present
// (current partial FY reads as FY-to-date) and otherwise uses the sheet's own
// annual point for the years that only have yearly data.
export type TimelinePoint = { label: string; value: number; end: string };

export function buildTimeline(series: FinPoint[], kind: "stock" | "flow", view: TrendView): TimelinePoint[] {
  const pts = series.filter((p): p is FinPoint & { amount: number } => p.amount != null);
  const monthly = pts.filter((p) => p.period_type === "monthly");
  const annual = pts.filter((p) => p.period_type === "annual");

  const agg = (arr: { amount: number; period_end_date: string }[]) =>
    kind === "flow"
      ? arr.reduce((s, p) => s + p.amount, 0)
      : [...arr].sort((a, b) => a.period_end_date.localeCompare(b.period_end_date)).slice(-1)[0].amount;

  if (view === "monthly") {
    return [...monthly]
      .sort((a, b) => a.period_end_date.localeCompare(b.period_end_date))
      .map((p) => ({ label: periodLabel(p), value: p.amount, end: p.period_end_date }));
  }

  if (view === "quarterly") {
    const buckets = new Map<string, { label: string; arr: typeof monthly; sort: string }>();
    for (const p of monthly) {
      const d = new Date(p.period_end_date);
      const fy = fyOf(d);
      const m = d.getUTCMonth() + 1;
      const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
      const key = `${fy}-Q${q}`;
      const b = buckets.get(key) || { label: `Q${q} FY${String(fy + 1).slice(-2)}`, arr: [], sort: p.period_end_date };
      b.arr.push(p);
      if (p.period_end_date > b.sort) b.sort = p.period_end_date;
      buckets.set(key, b);
    }
    return [...buckets.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map((b) => ({ label: b.label, value: agg(b.arr), end: b.sort }));
  }

  const fyMap = new Map<number, typeof monthly>();
  for (const p of monthly) {
    const fy = fyOf(new Date(p.period_end_date));
    (fyMap.get(fy) || fyMap.set(fy, []).get(fy)!).push(p);
  }
  const annualByFy = new Map<number, { amount: number; period_end_date: string }>();
  for (const p of annual) annualByFy.set(fyOf(new Date(p.period_end_date)), p);
  const fys = [...new Set<number>([...fyMap.keys(), ...annualByFy.keys()])].sort((a, b) => a - b);
  return fys.map((fy) => {
    const value = fyMap.has(fy) ? agg(fyMap.get(fy)!) : annualByFy.get(fy)!.amount;
    return { label: `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`, value, end: `${fy + 1}-03-31` };
  });
}

// Period labels across several timelines, chronological. Each timeline is
// sorted on its own, but a period only some items carry (a yearly sheet added
// later) would land at the end in first-seen order — and the labels themselves
// ("Jun 2026", "Q1 FY27", "FY 24-25") don't sort as strings.
export function mergedLabels(timelines: TimelinePoint[][]): string[] {
  const ends = new Map<string, string>();
  for (const tl of timelines) for (const p of tl) if (!ends.has(p.label)) ends.set(p.label, p.end);
  return [...ends.keys()].sort((a, b) => ends.get(a)!.localeCompare(ends.get(b)!));
}

export function valueAt(series: FinPoint[], periodEnd: string): number | null {
  const p = series.find((x) => x.period_end_date === periodEnd);
  return p && p.amount != null ? p.amount : null;
}

// Aggregated value of a series for a chosen granularity bucket (e.g. "FY 25-26"
// or "Jun 2026") — stock keeps the last value in the bucket, flow sums it.
export function bucketValue(series: FinPoint[], kind: "stock" | "flow", view: TrendView, label: string): number | null {
  const hit = buildTimeline(series, kind, view).find((x) => x.label === label);
  return hit ? hit.value : null;
}

// The bucket label a single point falls under — mirrors buildTimeline's own
// grouping so a point's percent lands on the same bucket as its value.
function pointBucketLabel(p: FinPoint, view: TrendView): string {
  if (view === "monthly") return periodLabel(p);
  const d = new Date(p.period_end_date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const fy = m >= 4 ? y : y - 1;
  if (view === "quarterly") {
    const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
    return `Q${q} FY${String(fy + 1).slice(-2)}`;
  }
  return `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
}

// The sheet's OWN percent for a bucket. Percents are ratios the sheet computes
// against a base it chooses (composition, % of Sales, …), so they must never be
// summed or re-averaged across periods — a multi-month bucket takes the latest
// point's percent, the same "keep the latest point in the bucket" rule
// bucketStockSeriesWithPercent uses. In the monthly view (one point per bucket)
// it's simply that month's percent as typed in the sheet. Prefers monthly
// points (matching buildTimeline); falls back to an annual point for FYs that
// only carry yearly data. Returns null when the sheet left the % cell blank.
export function bucketPercent(series: FinPoint[], view: TrendView, label: string): number | null {
  const pts = series.filter((p) => p.amount != null);
  const monthlyHits = pts.filter((p) => p.period_type === "monthly" && pointBucketLabel(p, view) === label);
  const pool = monthlyHits.length > 0
    ? monthlyHits
    : pts.filter((p) => p.period_type === "annual" && periodLabel(p) === label);
  if (pool.length === 0) return null;
  const latest = [...pool].sort((a, b) => a.period_end_date.localeCompare(b.period_end_date)).slice(-1)[0];
  return latest.percent ?? null;
}

// The ordered bucket labels a series produces at a given granularity — used to
// populate the one universal period picker per tab.
export function bucketLabelsOf(series: FinPoint[], kind: "stock" | "flow", view: TrendView): string[] {
  return [...new Set(buildTimeline(series, kind, view).map((x) => x.label))];
}

// The actual period-end date of a bucket (the latest data point inside it) — so a
// stock KPI can be labelled "as at <date>" rather than by the bucket name. This
// makes clear that a quarter/year balance IS the period-end snapshot, not a sum.
export function bucketEndDate(series: FinPoint[], view: TrendView, label: string): string | null {
  const inBucket = series.filter((p) => p.amount != null && pointBucketLabel(p, view) === label);
  if (inBucket.length === 0) return null;
  return [...inBucket].sort((a, b) => a.period_end_date.localeCompare(b.period_end_date)).slice(-1)[0].period_end_date;
}

// Value at the selected bucket plus the previous bucket (for a like-for-like
// period-over-period delta at the current granularity — never crossing the seam).
export function bucketChange(series: FinPoint[], kind: "stock" | "flow", view: TrendView, bucket: string):
  { value: number | null; prevValue: number | null; prevLabel: string | null } {
  const tl = buildTimeline(series, kind, view);
  const idx = tl.findIndex((x) => x.label === bucket);
  return {
    value: idx >= 0 ? tl[idx].value : null,
    prevValue: idx > 0 ? tl[idx - 1].value : null,
    prevLabel: idx > 0 ? tl[idx - 1].label : null,
  };
}

// ── Primitive UI ─────────────────────────────────────────────────────────────
export function Card({ title, note, right, children }: { title?: string; note?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white border border-[#EAE3D6] rounded-2xl p-5">
      {(title || right) && (
        <div className="flex items-start justify-between gap-3 mb-1">
          {title && (
            <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ background: SOURCES_COLOR }} /> {title}
            </h3>
          )}
          {right}
        </div>
      )}
      {note && <p className="text-[11px] text-gray-500 mb-3">{note}</p>}
      {children}
    </section>
  );
}

export function KpiCard({ label, value, deltaPct, deltaPeriod, accent = SOURCES_COLOR, exact, share, shareOf }:
  { label: string; value: string; deltaPct?: number | null; deltaPeriod?: string | null; accent?: string;
    exact?: string;
    /** The sheet's own ratio for this line (0-1), e.g. % of Sales. Rendered as a
     *  chip beside the value. Null/undefined when the sheet left the % blank —
     *  never computed here, so nothing invented. */
    share?: number | null;
    /** What the share is a percentage OF, e.g. "of Sales". */
    shareOf?: string }) {
  const dc = deltaPct == null ? NEUTRAL_COLOR : deltaPct >= 0 ? SUCCESS_COLOR : DANGER_COLOR;
  return (
    <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-4 overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: accent }} />
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</div>
      <div className="flex items-baseline gap-2 mt-1 flex-wrap">
        <span className="text-2xl font-bold text-gray-800 tracking-tight" title={exact}>{value}</span>
        {share != null && (
          <span
            className="text-[11px] font-bold px-1.5 py-0.5 rounded-md whitespace-nowrap"
            style={{ background: `${accent}14`, color: accent }}
            title={shareOf ? `${formatShare(share)} ${shareOf}` : formatShare(share)}
          >
            {formatShare(share)}
          </span>
        )}
      </div>
      {deltaPct !== undefined && (
        <div className="text-[11px] font-semibold mt-0.5" style={{ color: dc }}>
          {formatPct(deltaPct)}{deltaPeriod ? <span className="text-gray-500 font-medium"> · {deltaPeriod}</span> : null}
        </div>
      )}
    </div>
  );
}

export function BucketToggle({ view, onChange }: { view: TrendView; onChange: (v: TrendView) => void }) {
  return (
    <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
      {(["monthly", "quarterly", "yearly"] as TrendView[]).map((v) => (
        <button key={v} onClick={() => onChange(v)}
          className={`text-[11px] font-semibold px-3 py-1.5 rounded-md capitalize transition-all ${view === v ? "bg-white text-gray-800 shadow-sm" : "text-gray-500"}`}>
          {v}
        </button>
      ))}
    </div>
  );
}

export function BucketSelect({ labels, value, onChange }: { labels: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="text-[11px] font-semibold text-gray-700 bg-gray-100 rounded-lg px-3 py-1.5 outline-none">
      {labels.map((l) => <option key={l} value={l}>{l}</option>)}
    </select>
  );
}

// One universal control bar per tab: the granularity everything renders at, plus
// which bucket the snapshot views (donut / bridge / KPIs) point to.
/** Lets FinancePage inject the company selector into every view's sticky
 *  controls bar — and tell it how far down to stick — without threading props
 *  through all four views. `top` is measured from the page header's real
 *  height so the bar never overlaps it. */
export const StickyLeadingContext = createContext<{ leading: ReactNode; top: number }>({
  leading: null,
  top: 68,
});

export function DashboardControls({ view, onView, labels, bucket, onBucket, leading }:
  { view: TrendView; onView: (v: TrendView) => void; labels: string[]; bucket: string;
    onBucket: (v: string) => void;
    /** Rendered in place of the "View" label — used to surface the company
     *  selector once the page's own selector has scrolled out of sight. */
    leading?: ReactNode }) {
  const { leading: injected, top } = useContext(StickyLeadingContext);
  const lead = leading ?? injected;
  return (
    <div
      className="no-print sticky z-20 flex items-center justify-between flex-wrap gap-2 bg-white/90 backdrop-blur border border-[#EAE3D6] rounded-xl px-3 py-2 shadow-sm"
      style={{ top }}
    >
      {lead ?? <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">View</span>}
      <div className="flex items-center gap-2">
        <BucketToggle view={view} onChange={onView} />
        <BucketSelect labels={labels} value={bucket} onChange={onBucket} />
      </div>
    </div>
  );
}

// A solid header band between major dashboard sections — deliberately a level
// ABOVE the white cards (dark fill, uppercase, accent bar) so a section reads as
// clearly owning the cards beneath it, not blending in with card titles.
export function SectionHeading({ children, accent = SOURCES_COLOR }: { children: ReactNode; accent?: string }) {
  return (
    <div className="flex items-center gap-3 mt-5 px-4 py-3 rounded-xl bg-[#14161A] shadow-sm">
      <span className="w-1.5 h-5 rounded-full" style={{ background: accent }} />
      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-white">{children}</h2>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="text-sm text-gray-500 bg-[#FAF7F1] border border-dashed border-[#EAE3D6] rounded-2xl p-8 text-center">
      {children}
    </div>
  );
}

// Dependency-free inline sparkline (kept out of Recharts to avoid dozens of
// ResponsiveContainers inside a table).
export function Sparkline({ values, color = SOURCES_COLOR, width = 68, height = 22 }:
  { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return <span className="text-gray-400 text-[10px]">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 1 - ((v - min) / span) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Shared line-chart styling ────────────────────────────────────────────────
// One place for the "advanced" look — gradient area fills, glossy dots, and a
// refined tooltip — so every trend chart in the module reads the same.

/** <defs> of soft top→transparent gradients, one per series colour. Reference a
 *  fill as url(#<idPrefix>-<i>). */
function GradientDefs({ colors, idPrefix, strong = false }: { colors: string[]; idPrefix: string; strong?: boolean }) {
  const top = strong ? 0.38 : 0.22;
  const mid = strong ? 0.12 : 0.05;
  return (
    <defs>
      {colors.map((c, i) => (
        <linearGradient key={i} id={`${idPrefix}-${i}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity={top} />
          <stop offset="65%" stopColor={c} stopOpacity={mid} />
          <stop offset="100%" stopColor={c} stopOpacity={0} />
        </linearGradient>
      ))}
    </defs>
  );
}

/** A filled dot with a white ring — the "marker" look, on every point. */
function makeDot(color: string) {
  return (props: any) => {
    const { cx, cy, value } = props;
    if (cx == null || cy == null || value == null) return <g />;
    return (
      <g>
        <circle cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={1.5} />
      </g>
    );
  };
}

/** Bigger dot on hover so the active point stands out. */
function makeActiveDot(color: string) {
  return (props: any) => {
    const { cx, cy } = props;
    if (cx == null || cy == null) return <g />;
    return (
      <g>
        <circle cx={cx} cy={cy} r={7} fill={color} fillOpacity={0.18} />
        <circle cx={cx} cy={cy} r={4.5} fill={color} stroke="#fff" strokeWidth={2} />
      </g>
    );
  };
}

/** Rounded, shadowed tooltip container used across the trend charts. */
const TREND_TOOLTIP_STYLE: React.CSSProperties = {
  fontSize: 12,
  borderRadius: 12,
  border: `1px solid ${GRID_LINE_COLOR}`,
  boxShadow: "0 8px 24px rgba(20,22,26,0.12)",
  padding: "8px 12px",
};

// ── Trend chart (area for stock, bars + optional line for flow) ──────────────
export function MoneyTrendCard({ title, note, primary, primaryLabel, kind, secondary, secondaryLabel, view }:
  {
    title: string; note?: string; primary: FinPoint[]; primaryLabel: string; kind: "stock" | "flow";
    secondary?: FinPoint[]; secondaryLabel?: string; view: TrendView;
  }) {
  const data = useMemo(() => {
    const a = buildTimeline(primary, kind, view);
    const b = secondary ? buildTimeline(secondary, kind, view) : [];
    const bByLabel = new Map(b.map((x) => [x.label, x.value]));
    return a.map((x) => ({
      label: x.label,
      primary: x.value,
      secondary: bByLabel.get(x.label) ?? null,
      // The sheet's own share for each series at this bucket, surfaced in the
      // tooltip. Null wherever the sheet left the % blank.
      primaryPct: bucketPercent(primary, view, x.label),
      secondaryPct: secondary ? bucketPercent(secondary, view, x.label) : null,
    }));
  }, [primary, secondary, kind, view]);

  return (
    <Card title={title} note={note}>
      {data.length === 0 ? (
        <EmptyState>No periods to plot yet.</EmptyState>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="finPrimaryFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SOURCES_COLOR} stopOpacity={0.28} />
                <stop offset="100%" stopColor={SOURCES_COLOR} stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
            <YAxis tickFormatter={(v) => formatCompact(v)} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={64} />
            <Tooltip
              formatter={(v: any, n: any, item: any) => {
                const pct = n === "primary" ? item?.payload?.primaryPct : item?.payload?.secondaryPct;
                const money = formatINR(Number(v));
                return [pct != null ? `${money} · ${formatShare(pct)}` : money,
                  n === "primary" ? primaryLabel : secondaryLabel];
              }}
              contentStyle={TREND_TOOLTIP_STYLE} />
            {kind === "stock" ? (
              <Area type="monotone" dataKey="primary" name="primary" stroke={SOURCES_COLOR} strokeWidth={2.5} fill="url(#finPrimaryFill)"
                dot={makeDot(SOURCES_COLOR)} activeDot={makeActiveDot(SOURCES_COLOR)} />
            ) : (
              <Bar dataKey="primary" name="primary" fill={SOURCES_COLOR} radius={[3, 3, 0, 0]} maxBarSize={44} />
            )}
            {secondary && <Line type="monotone" dataKey="secondary" name="secondary" stroke={DANGER_COLOR} strokeWidth={2.5} dot={makeDot(DANGER_COLOR)} activeDot={makeActiveDot(DANGER_COLOR)} />}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ── Donut — current mix of one additive sub-section at the snapshot period ────
function DonutCard({ sub, kind, view, bucket, groupLabel, colorMap }:
  { sub: FinSubSection; kind: "stock" | "flow"; view: TrendView; bucket: string; groupLabel: string; colorMap: Map<string, string> }) {
  const rows = useMemo(() => sub.line_items
    .map((it) => ({ key: it.line_key, label: it.line_label, value: bucketValue(it.series, kind, view, bucket) ?? 0, percent: bucketPercent(it.series, view, bucket) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value), [sub, kind, view, bucket]);
  const total = bucketValue(sub.total?.series ?? [], kind, view, bucket) ?? rows.reduce((s, r) => s + r.value, 0);

  const title = sub.label ?? groupLabel;
  if (rows.length === 0) return <Card title={title} note={`Composition · ${bucket}`}><div className="text-[11px] text-gray-500 py-6">No positive values this period.</div></Card>;

  return (
    <Card title={title} note={`Slice size by ₹ · % as per sheet · ${bucket}`}>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative" style={{ width: 168, height: 168 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows} dataKey="value" nameKey="label" innerRadius={54} outerRadius={80} paddingAngle={1.5} stroke="#fff" strokeWidth={2}>
                {rows.map((r) => <Cell key={r.key} fill={colorMap.get(r.key)} />)}
              </Pie>
              <Tooltip formatter={(v: any, n: any) => [formatINR(Number(v)), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Total</span>
            <span className="text-sm font-bold text-gray-800" title={formatINR(total)}>{formatCompact(total)}</span>
          </div>
        </div>
        <div className="flex-1 min-w-[180px] flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-[12px]">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorMap.get(r.key) }} />
              <span className="text-gray-600 truncate flex-1" title={r.label}>{r.label}</span>
              <span className="font-semibold text-gray-700" title={formatINR(r.value)}>{formatCompact(r.value)}</span>
              <span className="text-gray-500 w-12 text-right tabular-nums" title="Percentage as entered in the sheet">
                {r.percent == null ? "—" : `${(r.percent * 100).toFixed(1)}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Stacked bars — one additive sub-section's composition per period ─────────
function CompositionByPeriodCard({ sub, kind, groupLabel, colorMap, view }:
  { sub: FinSubSection; kind: "stock" | "flow"; groupLabel: string; colorMap: Map<string, string>; view: TrendView }) {
  const [mode, setMode] = useState<"pct" | "abs">("pct");
  const items = sub.line_items;

  const { data, keys } = useMemo(() => {
    const perItem = items.map((it) => ({ it, tl: buildTimeline(it.series, kind, view) }));
    const labels = mergedLabels(perItem.map((p) => p.tl));
    const rows = labels.map((label) => {
      const row: Record<string, any> = { label };
      for (const { it, tl } of perItem) row[it.line_key] = tl.find((x) => x.label === label)?.value ?? 0;
      return row;
    });
    return { data: rows, keys: perItem.map((p) => p.it) };
  }, [items, kind, view]);

  return (
    <Card title={`${sub.label ?? groupLabel} — composition by period`} note="Each period's components stacked — as a share (%) or absolute value (₹)."
      right={
        <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
          {(["pct", "abs"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`text-[10px] font-semibold px-2 py-1 rounded-md transition-all ${mode === m ? "bg-white text-gray-800 shadow-sm" : "text-gray-500"}`}>{m === "pct" ? "%" : "₹"}</button>
          ))}
        </div>
      }>
      {data.length === 0 ? <div className="text-[11px] text-gray-500 py-6">No periods yet.</div> : (
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }} stackOffset={mode === "pct" ? "expand" : "none"}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
            <YAxis tickFormatter={(v) => (mode === "pct" ? `${Math.round(v * 100)}%` : formatCompact(v))}
              tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={54} />
            <Tooltip formatter={(v: any, n: any) => [formatINR(Number(v)), n]}
              contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            {keys.map((it) => (
              <Bar key={it.line_key} dataKey={it.line_key} name={it.line_label} stackId="c"
                fill={colorMap.get(it.line_key)} maxBarSize={64} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ── Top movers — biggest MoM changes among a group's line items ──────────────
// (Kept for reuse; no longer rendered per-section — the Watch List covers this.)
export function TopMoversCard({ group }: { group: FinGroup }) {
  const movers = useMemo(() => {
    const all: { key: string; label: string; latest: number; pct: number | null; delta: number }[] = [];
    for (const sub of group.sub_sections) {
      for (const it of sub.line_items) {
        const monthly = it.series.filter((p) => p.period_type === "monthly" && p.amount != null)
          .sort((a, b) => a.period_end_date.localeCompare(b.period_end_date));
        if (monthly.length < 2) continue;
        const curr = monthly[monthly.length - 1].amount!;
        const prev = monthly[monthly.length - 2].amount!;
        const d = computeDelta(curr, prev);
        all.push({ key: it.line_key, label: it.line_label, latest: curr, pct: d.pct, delta: d.delta ?? 0 });
      }
    }
    return all.filter((m) => m.pct != null).sort((a, b) => Math.abs(b.pct!) - Math.abs(a.pct!)).slice(0, 6);
  }, [group]);

  if (movers.length === 0) return null;
  return (
    <Card title="Top Movers" note="Largest month-on-month changes in this section.">
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
        {movers.map((m) => {
          const up = (m.delta ?? 0) >= 0;
          return (
            <div key={m.key} className="flex items-center gap-2 text-[12px]">
              <span className="text-gray-600 truncate flex-1" title={m.label}>{m.label}</span>
              <span className="font-semibold text-gray-700" title={formatINR(m.latest)}>{formatCompact(m.latest)}</span>
              <span className="font-bold w-16 text-right" style={{ color: up ? SUCCESS_COLOR : DANGER_COLOR }}>
                {up ? "▲" : "▼"} {formatPct(m.pct)}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Line-item table ───────────────────────────────────────────────────────────
// Shows ONE granularity at a time (monthly / quarterly / yearly) so it never
// puts a full-year column next to a single-month column — mixing the two reads
// as a false month-vs-year comparison. Same bucketing as the trend charts, so
// the columns are always like-for-like. Sparkline + light heatmap keep it from
// reading like a raw spreadsheet.
// ₹ vs % is a genuinely different dimension rather than a different time slice,
// so it keeps a local toggle — the one documented exception to the "one
// universal control per tab" rule. The % shown is always the sheet's own.
export type ValueMode = "amount" | "percent";

export function ValueModeToggle({ mode, onChange }: { mode: ValueMode; onChange: (m: ValueMode) => void }) {
  return (
    <div className="flex items-center bg-gray-100 rounded-lg p-0.5 no-print">
      {([["amount", "₹"], ["percent", "%"]] as [ValueMode, string][]).map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-all ${mode === v ? "bg-white text-gray-800 shadow-sm" : "text-gray-500"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function LineItemTable({ group, kind, view, mode = "amount" }:
  { group: FinGroup; kind: "stock" | "flow"; view: TrendView; mode?: ValueMode }) {
  const rows: { label: string; series: FinPoint[]; bold: boolean; indent: boolean }[] = [];
  for (const sub of group.sub_sections) {
    if (sub.label) rows.push({ label: sub.label, series: [], bold: true, indent: false });
    for (const it of sub.line_items) rows.push({ label: it.line_label, series: it.series, bold: false, indent: !!sub.label });
    if (sub.total) rows.push({ label: sub.total.line_label, series: sub.total.series, bold: true, indent: false });
  }

  const cols = useMemo(() => {
    const all: FinPoint[] = [];
    for (const sub of group.sub_sections) {
      for (const it of sub.line_items) all.push(...it.series);
      if (sub.total) all.push(...sub.total.series);
    }
    // buildTimeline over concatenated series emits one entry PER POINT in monthly
    // view (many rows share a month), so dedupe the labels to distinct periods.
    const distinct = [...new Set(buildTimeline(all, kind, view).map((x) => x.label))];
    return distinct.slice(-8);
  }, [group, kind, view]);

  const bucketed = useMemo((): (Map<string, number | null> | null)[] =>
    rows.map((r) => (r.series.length ? new Map(buildTimeline(r.series, kind, view).map((x) => [x.label, x.value])) : null)),
    [rows, kind, view]);

  // The sheet's OWN percent per bucket — bucketPercent applies the same "latest
  // point in the bucket" rule used elsewhere, so a quarter/year % is a figure
  // the sheet actually typed, never a re-average of monthly percentages.
  const bucketedPct = useMemo((): (Map<string, number | null> | null)[] =>
    rows.map((r) => (r.series.length ? new Map(cols.map((c) => [c, bucketPercent(r.series, view, c)])) : null)),
    [rows, view, cols]);

  return (
    <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-200">
              <th className="text-left py-2 pr-3 font-semibold text-gray-500 sticky left-0 bg-white">Particulars</th>
              <th className="text-center py-2 px-2 font-semibold text-gray-500">Trend</th>
              {cols.map((c) => (
                <th key={c} className="text-right py-2 px-3 font-semibold text-gray-500 whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const m = mode === "percent" ? bucketedPct[i] : bucketed[i];
              const vals = m ? cols.map((c) => m.get(c)).filter((v): v is number => v != null) : [];
              const rowMax = Math.max(mode === "percent" ? Number.MIN_VALUE : 1, ...vals.map(Math.abs));
              return (
                <tr key={i} className="border-b border-gray-100">
                  <td className={`py-2 pr-3 sticky left-0 bg-white ${r.bold ? "font-bold text-gray-800" : "text-gray-600"} ${r.indent ? "pl-3" : ""}`}>{r.label}</td>
                  <td className="py-1 px-2 text-center">{vals.length >= 2 ? <Sparkline values={vals} color={r.bold ? NETT_PROFIT_COLOR : SOURCES_COLOR} /> : <span className="text-gray-400">—</span>}</td>
                  {cols.map((c) => {
                    const v = m ? m.get(c) ?? null : null;
                    const shade = v != null && !r.bold ? Math.min(0.14, (Math.abs(v) / rowMax) * 0.14) : 0;
                    return (
                      <td key={c} className={`py-2 px-3 text-right whitespace-nowrap ${r.bold ? "font-semibold text-gray-800" : "text-gray-600"}`}
                        style={{ background: shade ? `rgba(78,101,117,${shade})` : undefined }}
                        title={v != null && mode === "amount" ? formatINR(v) : ""}>
                        {v == null ? "—" : mode === "percent" ? formatShare(v) : formatCompact(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
    </div>
  );
}

// ── P&L profit bridge (horizontal: Sales → PAT levels + the deduction between) ─
export function ProfitBridgeCard({ group, view, bucket }: { group: FinGroup; view: TrendView; bucket: string }) {
  const items = group.sub_sections[0]?.line_items ?? [];
  const byKey = (slug: string) => items.find((i) => i.line_key.endsWith(`/${slug}`));
  const anchorsDef = [
    { slug: "sales_accounts", label: "Sales", color: REVENUE_COLOR },
    { slug: "gross_margin", label: "Gross Margin", color: GROSS_PROFIT_COLOR },
    { slug: "pbitda", label: "PBITDA", color: SOURCES_COLOR },
    { slug: "pbt", label: "PBT", color: SOURCES_COLOR },
    { slug: "pat", label: "PAT", color: SUCCESS_COLOR },
  ];
  // What's deducted (net) to get from one level to the next.
  const stepLabels = ["Cost of sales (net)", "Operating & overhead (net)", "Finance & depreciation", "Tax"];
  const anchors = anchorsDef
    .map((a) => ({ ...a, value: (() => { const it = byKey(a.slug); return it ? bucketValue(it.series, "flow", view, bucket) : null; })() }))
    .filter((a) => a.value != null) as { slug: string; label: string; color: string; value: number }[];

  const periodText = bucket;
  if (anchors.length < 2) return null;
  const sales = anchors[0].value || 1;

  return (
    <Card title="Profit Bridge" note={`How Sales becomes PAT · ${periodText}. Each level shrinks by the deduction shown beneath it.`}>
      <div className="flex flex-col gap-1">
        {anchors.map((a, i) => {
          const pct = (a.value / sales) * 100;
          const barW = Math.max(pct, 2);
          // Rounding to whole percent turns a real 0.26% into a meaningless
          // "0%", so thin levels keep enough precision to stay a number.
          const pctText = pct >= 10 ? `${Math.round(pct)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
          // Below ~8% the bar is too narrow to hold its own label, so the label
          // moves outside it rather than being clipped to an unreadable sliver.
          const labelInside = pct >= 8;
          return (
            <div key={a.slug}>
              <div className="flex items-center gap-3 py-1.5">
                <div className="w-28 shrink-0 text-[12px] font-semibold text-gray-700">{a.label}</div>
                <div className="relative flex-1 h-6 bg-gray-50 rounded-md overflow-hidden">
                  <div className="h-full rounded-md flex items-center justify-end pr-2" style={{ width: `${barW}%`, background: a.color }}>
                    {labelInside && <span className="text-[10px] font-bold text-white/90">{pctText}</span>}
                  </div>
                  {!labelInside && (
                    <span className="absolute top-0 h-full flex items-center text-[10px] font-bold text-gray-500"
                      style={{ left: `calc(${barW}% + 6px)` }}>
                      {pctText}
                    </span>
                  )}
                </div>
                <div className="w-24 shrink-0 text-right text-[13px] font-bold text-gray-800" title={formatINR(a.value)}>{formatCompact(a.value)}</div>
              </div>
              {i < anchors.length - 1 && (
                <div className="flex items-center gap-3 pl-28">
                  <div className="flex-1 text-[11px] text-gray-500 flex items-center gap-1.5">
                    <span style={{ color: DANGER_COLOR }}>↓</span> {stepLabels[i] ?? "Deductions"}
                  </div>
                  <div className="w-24 shrink-0 text-right text-[11px] font-semibold" style={{ color: DANGER_COLOR }} title={formatINR(anchors[i].value - anchors[i + 1].value)}>
                    −{formatCompact(anchors[i].value - anchors[i + 1].value)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── P&L margin trend (Gross Margin % and PAT % of Sales over time) ───────────
export function MarginTrendCard({ salesSeries, grossSeries, patSeries, view }:
  { salesSeries: FinPoint[]; grossSeries: FinPoint[]; patSeries: FinPoint[]; view: TrendView }) {
  const data = useMemo(() => {
    const s = buildTimeline(salesSeries, "flow", view);
    const g = buildTimeline(grossSeries, "flow", view);
    const p = buildTimeline(patSeries, "flow", view);
    const gm = new Map(g.map((x) => [x.label, x.value]));
    const pm = new Map(p.map((x) => [x.label, x.value]));
    return s.map((x) => ({
      label: x.label,
      gross: x.value > 0 ? ((gm.get(x.label) ?? 0) / x.value) * 100 : null,
      pat: x.value > 0 ? ((pm.get(x.label) ?? 0) / x.value) * 100 : null,
    }));
  }, [salesSeries, grossSeries, patSeries, view]);

  return (
    <Card title="Margins" note="Gross Margin and PAT as a % of Sales.">
      {data.length === 0 ? <div className="text-[11px] text-gray-500 py-6">No periods yet.</div> : (
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <GradientDefs colors={[SUCCESS_COLOR, NETT_PROFIT_COLOR]} idPrefix="marginFill" />
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
            <YAxis tickFormatter={(v) => `${Math.round(v)}%`} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={44} />
            <ReferenceLine y={0} stroke={GRID_LINE_COLOR} />
            <Tooltip formatter={(v: any, n: any) => [v == null ? "—" : `${Number(v).toFixed(1)}%`, n === "gross" ? "Gross Margin" : "PAT"]}
              contentStyle={TREND_TOOLTIP_STYLE} />
            <Area type="monotone" dataKey="gross" name="gross" stroke={SUCCESS_COLOR} strokeWidth={2.5}
              fill="url(#marginFill-0)" dot={makeDot(SUCCESS_COLOR)} activeDot={makeActiveDot(SUCCESS_COLOR)} connectNulls />
            <Area type="monotone" dataKey="pat" name="pat" stroke={NETT_PROFIT_COLOR} strokeWidth={2.5}
              fill="url(#marginFill-1)" dot={makeDot(NETT_PROFIT_COLOR)} activeDot={makeActiveDot(NETT_PROFIT_COLOR)} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ── Key Financial Ratios — a card per ratio, grouped by category ─────────────
// Ratios are heterogeneous: some are multiples (Current Ratio 1.75×), some are
// day-counts (Recv. Turnover 45 days), some are rates stored as decimals
// (Return on Investment 0.18 = 18%). Format by the ratio's own label rather
// than assuming one convention.
function formatRatio(label: string, v: number): string {
  const l = label.toLowerCase();
  if (l.includes("day")) return `${Math.round(v)} days`;
  if (l.includes("%") || l.includes("growth") || l.includes("return on")) return `${(v * 100).toFixed(1)}%`;
  return `${v.toFixed(2)}×`;
}

// Default healthy bands per ratio (matched by line_key suffix). Direction "high"
// = bigger is better, "low" = smaller is better. Values are in the ratio's own
// stored unit (× / decimal-fraction / days). These are sensible generic
// benchmarks — leadership can recalibrate to the company's own targets.
type Bench = { dir: "high" | "low"; good: number; warn: number; unit: "x" | "pct" | "days" };
const RATIO_BENCHMARKS: Record<string, Bench> = {
  current_ratio: { dir: "high", good: 1.5, warn: 1.0, unit: "x" },
  quick_ratio: { dir: "high", good: 1.0, warn: 0.7, unit: "x" },
  recv_turnover_in_days: { dir: "low", good: 45, warn: 60, unit: "days" },
  inventory_turnover_in_days: { dir: "low", good: 60, warn: 90, unit: "days" },
  vendor_turnover_in_days: { dir: "high", good: 45, warn: 30, unit: "days" },
  debt_equity_ratio: { dir: "low", good: 1, warn: 2, unit: "x" },
  debts_covering_ratio: { dir: "high", good: 3, warn: 1.5, unit: "x" },
  return_on_capital_employed: { dir: "high", good: 0.15, warn: 0.08, unit: "pct" },
  return_on_investment: { dir: "high", good: 0.15, warn: 0.08, unit: "pct" },
  return_on_equity_ratio: { dir: "high", good: 0.15, warn: 0.08, unit: "pct" },
  return_on_wkg_capital: { dir: "high", good: 0.2, warn: 0.1, unit: "pct" },
  sales_growth: { dir: "high", good: 0.1, warn: 0, unit: "pct" },
  profit_growth: { dir: "high", good: 0.1, warn: 0, unit: "pct" },
};
function ratioVerdict(lineKey: string, v: number): { status: "good" | "warn" | "bad"; target: string } | null {
  const key = Object.keys(RATIO_BENCHMARKS).find((k) => lineKey.endsWith(`/${k}`));
  if (!key) return null;
  const b = RATIO_BENCHMARKS[key];
  const status = b.dir === "high"
    ? (v >= b.good ? "good" : v >= b.warn ? "warn" : "bad")
    : (v <= b.good ? "good" : v <= b.warn ? "warn" : "bad");
  const fmt = (x: number) => (b.unit === "pct" ? `${Math.round(x * 100)}%` : b.unit === "days" ? `${x} days` : `${x}×`);
  return { status, target: `Target ${b.dir === "high" ? "≥" : "≤"} ${fmt(b.good)}` };
}
const RAG = { good: { c: SUCCESS_COLOR, bg: "#EDF4EE", t: "Healthy" }, warn: { c: "#B08400", bg: "#FBF3DD", t: "Watch" }, bad: { c: DANGER_COLOR, bg: "#F7E7E4", t: "Concern" } };

// A ratio bucketed to the chosen period — ratios aren't summable, so we take
// the latest ratio within the bucket (stock rule).
function ratioAt(it: RatioItem, view: TrendView, bucket: string): number | null {
  const tl = buildTimeline(it.series as unknown as FinPoint[], "stock", view);
  const hit = tl.find((x) => x.label === bucket);
  return hit ? hit.value : (tl.length ? tl[tl.length - 1].value : null);
}

function RatioCard({ it, view, bucket }: { it: RatioItem; view: TrendView; bucket: string }) {
  const spark = buildTimeline(it.series as unknown as FinPoint[], "stock", view).map((x) => x.value);
  const latest = ratioAt(it, view, bucket);
  const verdict = latest != null ? ratioVerdict(it.line_key, latest) : null;
  return (
    <div className="bg-[#FCFBF8] border border-[#EAE3D6] rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold text-gray-500 truncate" title={it.line_label}>{it.line_label}</div>
        {verdict && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ color: RAG[verdict.status].c, background: RAG[verdict.status].bg }}>{RAG[verdict.status].t}</span>}
      </div>
      <div className="text-xl font-bold text-gray-800 mt-1">{latest != null ? formatRatio(it.line_label, latest) : "—"}</div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-gray-500">{verdict?.target ?? ""}</span>
        <Sparkline values={spark} width={52} height={16} color={verdict ? RAG[verdict.status].c : SOURCES_COLOR} />
      </div>
    </div>
  );
}

export function RatiosPanel({ ratios, view, bucket, title = "Key Financial Ratios" }:
  { ratios: RatioCat[]; view: TrendView; bucket: string; title?: string }) {
  const cats = ratios.filter((c) => c.items.length > 0);
  if (cats.length === 0) return null;
  return (
    <Card title={title} note={`Value at ${bucket} vs a healthy benchmark (Healthy / Watch / Concern), with its trend spark.`}>
      <div className="flex flex-col gap-4">
        {cats.map((cat) => (
          <div key={cat.key}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2">{cat.label}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {cat.items.map((it) => <RatioCard key={it.line_key} it={it} view={view} bucket={bucket} />)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Cash Conversion Cycle (DIO + DSO − DPO) — days of cash trapped in ops ─────
export function CashCycleCard({ ratios, view, bucket }: { ratios: RatioCat[]; view: TrendView; bucket: string }) {
  const find = (suffix: string) => {
    for (const c of ratios) for (const it of c.items) if (it.line_key.endsWith(`/${suffix}`)) return ratioAt(it, view, bucket);
    return null;
  };
  const dio = find("inventory_turnover_in_days");
  const dso = find("recv_turnover_in_days");
  const dpo = find("vendor_turnover_in_days");
  if (dio == null || dso == null || dpo == null) return null;
  const ccc = dio + dso - dpo;
  const cccColor = ccc <= 60 ? SUCCESS_COLOR : ccc <= 90 ? "#B08400" : DANGER_COLOR;
  const stat = (label: string, v: number, sign = "") => (
    <div className="flex flex-col items-center px-4 py-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
      <span className="text-lg font-bold text-gray-800 mt-0.5">{sign}{Math.round(v)}</span>
      <span className="text-[9px] text-gray-500">days</span>
    </div>
  );
  return (
    <Card title="Cash Conversion Cycle" note="How many days cash is tied up in operations before it comes back — lower is better.">
      <div className="flex items-center flex-wrap gap-2">
        {stat("Inventory (DIO)", dio, "+")}
        <span className="text-gray-500 font-bold">+</span>
        {stat("Receivables (DSO)", dso, "+")}
        <span className="text-gray-500 font-bold">−</span>
        {stat("Payables (DPO)", dpo)}
        <span className="text-gray-500 font-bold">=</span>
        <div className="flex flex-col items-center px-5 py-2 rounded-xl" style={{ background: RAG[ccc <= 60 ? "good" : ccc <= 90 ? "warn" : "bad"].bg }}>
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: cccColor }}>Cash Cycle</span>
          <span className="text-2xl font-bold mt-0.5" style={{ color: cccColor }}>{Math.round(ccc)}</span>
          <span className="text-[9px]" style={{ color: cccColor }}>days</span>
        </div>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">CCC = DIO + DSO − DPO. {ccc > 0 ? `About ${Math.round(ccc)} days of working capital are locked in the operating cycle.` : "Suppliers are financing the full operating cycle."}</p>
    </Card>
  );
}

// ── Watch List — rule-based flags from the selected period's ratios + recon ──
function insightCCC(ratios: RatioCat[], view: TrendView, bucket: string): number | null {
  const find = (s: string) => {
    for (const c of ratios) for (const it of c.items) if (it.line_key.endsWith(`/${s}`)) return ratioAt(it, view, bucket);
    return null;
  };
  const dio = find("inventory_turnover_in_days"), dso = find("recv_turnover_in_days"), dpo = find("vendor_turnover_in_days");
  return dio != null && dso != null && dpo != null ? dio + dso - dpo : null;
}

export function buildInsights(data: FinAnalytics, view: TrendView, bucket: string): { sev: number; text: string }[] {
  const out: { sev: number; text: string }[] = [];
  for (const t of data.reconciliation ?? []) {
    if (!t.matches) out.push({ sev: 3, text: `${t.label} doesn't reconcile — off by ${formatCompact(Math.abs(t.delta))}.` });
  }
  for (const c of data.ratios ?? []) for (const it of c.items) {
    const v = ratioAt(it, view, bucket);
    if (v == null) continue;
    const verdict = ratioVerdict(it.line_key, v);
    if (verdict?.status === "bad") out.push({ sev: 3, text: `${it.line_label} at ${formatRatio(it.line_label, v)} — ${verdict.target}.` });
    else if (verdict?.status === "warn") out.push({ sev: 2, text: `${it.line_label} at ${formatRatio(it.line_label, v)} — watch (${verdict.target}).` });
  }
  const ccc = insightCCC(data.ratios ?? [], view, bucket);
  if (ccc != null && ccc > 90) out.push({ sev: 2, text: `Cash conversion cycle at ${Math.round(ccc)} days — heavy working-capital lock-up.` });
  const seen = new Set<string>();
  return out.filter((o) => !seen.has(o.text) && seen.add(o.text)).sort((a, b) => b.sev - a.sev).slice(0, 6);
}

export function WatchListCard({ data, view, bucket }: { data: FinAnalytics; view: TrendView; bucket: string }) {
  const items = buildInsights(data, view, bucket);
  const sevColor = (s: number) => (s >= 3 ? DANGER_COLOR : s >= 2 ? "#B08400" : SOURCES_COLOR);
  return (
    <Card title="Watch List" note="Auto-flagged from this period's ratios and reconciliation checks — worth a look.">
      {items.length === 0 ? (
        <div className="flex items-center gap-2 text-[13px] text-gray-500"><span className="font-bold" style={{ color: SUCCESS_COLOR }}>✓</span> All clear — no flags this period.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it, i) => (
            <div key={i} className="flex items-start gap-2.5 text-[13px]">
              <span className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: sevColor(it.sev) }} />
              <span className="text-gray-700">{it.text}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Cross-statement reconciliation (compact status; expands on demand / if off) ─
export function ReconciliationPanel({ ties }: { ties: ReconTie[] }) {
  const [open, setOpen] = useState(false);
  if (!ties || ties.length === 0) return null;
  const off = ties.filter((t) => !t.matches).length;
  const allTied = off === 0;
  const show = open || !allTied;
  return (
    <Card title="Reconciliation Checks" note="Cross-statement ties that must be equal if the accounts are consistent (latest period)."
      right={<button onClick={() => setOpen((o) => !o)} className="text-[11px] font-semibold text-gray-500 hover:text-gray-700">{show ? "Hide" : "Show"} details</button>}>
      <div className="flex items-center gap-2 text-[13px] font-bold" style={{ color: allTied ? SUCCESS_COLOR : DANGER_COLOR }}>
        {allTied ? `✓ All ${ties.length} checks tied` : `✗ ${off} of ${ties.length} checks off`}
      </div>
      {show && (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mt-3">
        {ties.map((t) => (
          <div key={t.label} className="rounded-xl border p-3" style={{ borderColor: t.matches ? "#CFE4D4" : "#EBCFCA", background: t.matches ? "#F4FAF5" : "#FCF3F1" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-bold text-gray-700">{t.label}</span>
              <span className="text-[11px] font-bold" style={{ color: t.matches ? SUCCESS_COLOR : DANGER_COLOR }}>{t.matches ? "✓ Tied" : "✗ Off"}</span>
            </div>
            <div className="mt-1.5 text-[11px] text-gray-500 flex items-center justify-between">
              <span>{t.left.name}</span><span className="font-semibold text-gray-700" title={formatINR(t.left.value)}>{formatCompact(t.left.value)}</span>
            </div>
            <div className="text-[11px] text-gray-500 flex items-center justify-between">
              <span>{t.right.name}</span><span className="font-semibold text-gray-700" title={formatINR(t.right.value)}>{formatCompact(t.right.value)}</span>
            </div>
            {!t.matches && <div className="text-[10px] font-semibold mt-1" style={{ color: DANGER_COLOR }}>Off by {formatCompact(Math.abs(t.delta))}</div>}
          </div>
        ))}
      </div>
      )}
    </Card>
  );
}

// ── Group block: donut + mix-over-time per additive sub-section, movers, table ─
export function GroupBlock({ group, view, bucket, kind }: { group: FinGroup; view: TrendView; bucket: string; kind: "stock" | "flow" }) {
  const additive = group.sub_sections.filter((s) => s.total);
  const [valueMode, setValueMode] = useState<ValueMode>("amount");
  // Only offer the % view where the sheet actually typed percentages — an empty
  // toggle that blanks the whole table would read as a bug.
  const hasPercent = useMemo(() => group.sub_sections.some((s) =>
    s.line_items.some((it) => it.series.some((p) => p.percent != null)) ||
    (s.total?.series.some((p) => p.percent != null) ?? false)
  ), [group]);
  return (
    <div className="flex flex-col gap-4">
      <SectionHeading>{group.section_label}</SectionHeading>
      {additive.map((sub) => {
        // One canonical color map per sub-section (item_no order) shared by both
        // charts, so each line item keeps the same color in the donut and the bars.
        const colorMap = buildColorMap(sub.line_items.map((i) => i.line_key));
        return (
          <div key={sub.key ?? group.section_key} className="grid gap-4 xl:grid-cols-2">
            <DonutCard sub={sub} kind={kind} view={view} bucket={bucket} groupLabel={group.section_label} colorMap={colorMap} />
            <CompositionByPeriodCard sub={sub} kind={kind} groupLabel={group.section_label} colorMap={colorMap} view={view} />
          </div>
        );
      })}
      <Card title={`${group.section_label} — detail`}
        note={valueMode === "percent"
          ? "The sheet's own percentages at the current granularity; use the View control at the top to switch period."
          : "Values at the current granularity; use the View control at the top to switch."}
        right={hasPercent ? <ValueModeToggle mode={valueMode} onChange={setValueMode} /> : undefined}>
        <LineItemTable group={group} kind={kind} view={view} mode={valueMode} />
      </Card>
    </div>
  );
}

// ── Working Capital Aging (§8) ───────────────────────────────────────────────
// Each category (Inventory / Debtors / Creditors) is split into money that is
// current (≤90 days) vs aged (>90 days). For assets (inventory, receivables)
// a rising aged share is a real red flag — cash stuck. For creditors it's just
// how long we're taking to pay, so we report it without a health verdict.
const AGED_COLOR = "#B5483A";     // overdue / >90 days
const CURRENT_COLOR = "#4E7D57";  // current / ≤90 days
const AGING_TREND_COLORS = [SOURCES_COLOR, APPLICATION_COLOR, GROSS_PROFIT_COLOR];

function agingBucketOf(sub: FinSubSection, endsWith: string): FinLineItem | undefined {
  return sub.line_items.find((it) => it.line_key.endsWith(endsWith));
}

export function AgingPanel({ group, view, bucket }: { group: FinGroup; view: TrendView; bucket: string }) {
  // Snapshot: current vs aged per category at the selected bucket.
  const cats = useMemo(() => group.sub_sections.map((sub) => {
    const cur = agingBucketOf(sub, "/lt_90_days");
    const aged = agingBucketOf(sub, "/gt_90_days");
    const current = cur ? bucketValue(cur.series, "stock", view, bucket) ?? 0 : 0;
    const overdue = aged ? bucketValue(aged.series, "stock", view, bucket) ?? 0 : 0;
    const total = current + overdue;
    const isAsset = sub.key === "inventory" || sub.key === "debtors";
    return { key: sub.key, label: sub.label ?? sub.key ?? "—", current, overdue, total, agedPct: total > 0 ? (overdue / total) * 100 : 0, isAsset };
  }), [group, view, bucket]);

  // Trend: aged share (%) per category over the whole timeline.
  const trend = useMemo(() => {
    const perCat = group.sub_sections.map((sub) => {
      const cur = agingBucketOf(sub, "/lt_90_days");
      const aged = agingBucketOf(sub, "/gt_90_days");
      const ctl = buildTimeline(cur?.series ?? [], "stock", view);
      const c = new Map(ctl.map((x) => [x.label, x.value]));
      const a = new Map(buildTimeline(aged?.series ?? [], "stock", view).map((x) => [x.label, x.value]));
      return { key: sub.key ?? "", label: sub.label ?? sub.key ?? "—", c, a, ctl };
    });
    const labels = mergedLabels(perCat.map((p) => p.ctl));
    return labels.map((label) => {
      const row: Record<string, any> = { label };
      for (const p of perCat) {
        const t = (p.c.get(label) ?? 0) + (p.a.get(label) ?? 0);
        row[p.key] = t > 0 ? ((p.a.get(label) ?? 0) / t) * 100 : null;
      }
      return row;
    });
  }, [group, view]);

  const hasData = cats.some((c) => c.total > 0);
  if (!hasData) return <EmptyState>No working-capital aging data yet.</EmptyState>;

  const trendCats = group.sub_sections.map((s, i) => ({ key: s.key ?? "", label: s.label ?? s.key ?? "—", color: AGING_TREND_COLORS[i % AGING_TREND_COLORS.length] }));

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Aging Profile · ${bucket}`}
        note="Current (≤90 days) vs aged (>90 days) for each pool. A high aged share on Inventory or Debtors means cash is stuck."
        right={
          <div className="flex items-center gap-3 text-[10px] font-semibold">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: CURRENT_COLOR }} /> ≤90d</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: AGED_COLOR }} /> &gt;90d</span>
          </div>
        }>
        <div className="flex flex-col gap-3.5 mt-1">
          {cats.map((c) => {
            const curPct = c.total > 0 ? (c.current / c.total) * 100 : 0;
            const verdict = c.isAsset ? (c.agedPct >= 30 ? RAG.bad : c.agedPct >= 15 ? RAG.warn : RAG.good) : null;
            return (
              <div key={c.key} className="flex items-center gap-3">
                <div className="w-24 shrink-0 text-[12px] font-semibold text-gray-700">{c.label}</div>
                <div className="flex-1 flex h-7 rounded-md overflow-hidden bg-gray-50" title={`Current ${formatINR(c.current)} · Aged ${formatINR(c.overdue)}`}>
                  <div className="h-full flex items-center pl-2" style={{ width: `${Math.max(curPct, 0)}%`, background: CURRENT_COLOR }}>
                    {curPct >= 16 && <span className="text-[10px] font-bold text-white/90 truncate">{formatCompact(c.current)}</span>}
                  </div>
                  <div className="h-full flex items-center justify-end pr-2" style={{ width: `${Math.max(c.agedPct, 0)}%`, background: AGED_COLOR }}>
                    {c.agedPct >= 16 && <span className="text-[10px] font-bold text-white/90 truncate">{formatCompact(c.overdue)}</span>}
                  </div>
                </div>
                <div className="w-28 shrink-0 flex items-center justify-end gap-2">
                  <span className="text-[12px] font-bold text-gray-800" title={formatINR(c.total)}>{formatCompact(c.total)}</span>
                  {verdict ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ color: verdict.c, background: verdict.bg }}>{Math.round(c.agedPct)}% aged</span>
                  ) : (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-gray-500 bg-gray-100">{Math.round(c.agedPct)}% &gt;90d</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Overdue Share Trend" note="Share of each pool sitting beyond 90 days, over time. Rising lines on Inventory or Debtors mean aging is worsening.">
        {trend.length === 0 ? <div className="text-[11px] text-gray-500 py-6">No periods yet.</div> : (
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <GradientDefs colors={trendCats.map((t) => t.color)} idPrefix="overdueFill" strong />
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
              <YAxis tickFormatter={(v) => `${Math.round(v)}%`} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={44} />
              <Tooltip formatter={(v: any, n: any) => [v == null ? "—" : `${Number(v).toFixed(1)}%`, trendCats.find((t) => t.key === n)?.label ?? n]}
                contentStyle={TREND_TOOLTIP_STYLE} />
              {trendCats.map((t, i) => (
                <Area key={t.key} type="monotone" dataKey={t.key} name={t.key} stroke={t.color} strokeWidth={2.5}
                  fill={`url(#overdueFill-${i})`} dot={makeDot(t.color)} activeDot={makeActiveDot(t.color)} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div className="flex items-center gap-4 flex-wrap mt-3 text-[11px]">
          {trendCats.map((t) => (
            <span key={t.key} className="flex items-center gap-1.5 text-gray-600"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: t.color }} /> {t.label}</span>
          ))}
        </div>
      </Card>

      <Card title="Aging — detail" note="Values at the current granularity; use the View control at the top to switch.">
        <LineItemTable group={group} kind="stock" view={view} />
      </Card>
    </div>
  );
}

// ── Average Unit Cost (§12) ──────────────────────────────────────────────────
// Unit cost is a RATE (₹ per unit), not an additive amount — so it is never
// summed or shown as a share of a whole (a donut/stacked bar would be
// meaningless). The two facts that matter are: what each product costs now, and
// how that cost is trending (cost inflation). Stock semantics: a yearly bucket
// takes the representative (latest) rate, never a sum.
const UNIT_COST_COLORS = [SOURCES_COLOR, APPLICATION_COLOR, GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, "#7A6E8F", "#4E7D57"];

export function UnitCostPanel({ group, view, bucket }: { group: FinGroup; view: TrendView; bucket: string }) {
  const items = useMemo(() => group.sub_sections.flatMap((s) => s.line_items), [group]);

  const snapshot = useMemo(() => items.map((it, i) => {
    const ch = bucketChange(it.series, "stock", view, bucket);
    const pct = ch.value != null && ch.prevValue != null && ch.prevValue !== 0
      ? ((ch.value - ch.prevValue) / ch.prevValue) * 100 : null;
    return { key: it.line_key, label: it.line_label, value: ch.value, pct, prevLabel: ch.prevLabel, color: UNIT_COST_COLORS[i % UNIT_COST_COLORS.length] };
  }).filter((r) => r.value != null && r.value > 0), [items, view, bucket]);

  const trend = useMemo(() => {
    const per = items.map((it) => {
      const tl = buildTimeline(it.series, "stock", view);
      return { it, tl, m: new Map(tl.map((x) => [x.label, x.value])) };
    });
    const labels = mergedLabels(per.map((p) => p.tl));
    return labels.map((label) => {
      const row: Record<string, any> = { label };
      for (const p of per) row[p.it.line_key] = p.m.get(label) ?? null;
      return row;
    });
  }, [items, view]);

  if (snapshot.length === 0) return <EmptyState>No average unit cost data yet.</EmptyState>;

  const maxV = Math.max(...snapshot.map((s) => s.value ?? 0), 1);
  const legend = items.map((it, i) => ({ key: it.line_key, label: it.line_label, color: UNIT_COST_COLORS[i % UNIT_COST_COLORS.length] }))
    .filter((l) => snapshot.some((s) => s.key === l.key));

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Unit Cost · ${bucket}`} note="Average cost per unit for each product line, with the change from the previous period.">
        <div className="flex flex-col gap-3 mt-1">
          {snapshot.map((s) => {
            const up = s.pct != null && s.pct > 0; // rising unit cost is unfavourable
            return (
              <div key={s.key} className="flex items-center gap-3">
                <div className="w-28 shrink-0 text-[12px] font-semibold text-gray-700 truncate" title={s.label}>{s.label}</div>
                <div className="flex-1 h-7 bg-gray-50 rounded-md overflow-hidden">
                  <div className="h-full rounded-md flex items-center justify-end pr-2" style={{ width: `${Math.max(((s.value ?? 0) / maxV) * 100, 3)}%`, background: s.color }}>
                    <span className="text-[10px] font-bold text-white/90">{formatCompact(s.value ?? 0)}</span>
                  </div>
                </div>
                <div className="w-20 shrink-0 text-right text-[11px] font-bold" style={{ color: s.pct == null ? NEUTRAL_COLOR : up ? DANGER_COLOR : SUCCESS_COLOR }}
                  title={s.prevLabel ? `vs ${s.prevLabel}` : undefined}>
                  {s.pct == null ? "—" : `${up ? "▲" : "▼"} ${Math.abs(s.pct).toFixed(1)}%`}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Unit Cost Trend" note="How each product's cost per unit moves over time — a rising line is cost inflation.">
        {trend.length === 0 ? <div className="text-[11px] text-gray-500 py-6">No periods yet.</div> : (
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <GradientDefs colors={legend.map((l) => l.color)} idPrefix="unitCostFill" strong />
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
              <YAxis tickFormatter={(v) => formatCompact(v)} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={54} />
              <Tooltip formatter={(v: any, n: any) => [v == null ? "—" : formatINR(Number(v)), legend.find((l) => l.key === n)?.label ?? n]}
                contentStyle={TREND_TOOLTIP_STYLE} />
              {legend.map((l, i) => (
                <Area key={l.key} type="monotone" dataKey={l.key} name={l.key} stroke={l.color} strokeWidth={2.5}
                  fill={`url(#unitCostFill-${i})`} dot={makeDot(l.color)} activeDot={makeActiveDot(l.color)} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div className="flex items-center gap-4 flex-wrap mt-3 text-[11px]">
          {legend.map((l) => (
            <span key={l.key} className="flex items-center gap-1.5 text-gray-600"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: l.color }} /> {l.label}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}
