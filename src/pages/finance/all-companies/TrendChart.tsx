// One line chart for the All Companies page: "how has this moved over time?".
//
// Built around three things the table below it cannot show:
//   * a fixed line (the group Total, or Budget vs Actual) that always reads first;
//   * a handful of companies you pick, drawn against it — never one line per
//     company, because twenty lines are a tangle nobody can read. The five
//     biggest are on by default; up to eight can be shown at once, each in its
//     own fixed colour (a company keeps its colour while it is on screen);
//   * a hover card with the exact figure for every line, and for a total how many
//     companies it covers — so a latest-month dip made of companies that simply
//     have not reported yet explains itself instead of reading as a collapse.
//
// The chart runs from the first period up to the PERIOD PICKED in the controls bar
// and stops there, so it matches the table below it. Whatever the sheet holds
// after that month — often a month finance has only part-filled — is not drawn;
// picking a later period extends the chart to it.
//
// A hollow dot marks a total that does not cover every company.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Card, EmptyState } from "../dashboardKit";
import { AXIS_TEXT_COLOR, GRID_LINE_COLOR } from "../format";
import { labelsUpTo, rankLabel, topKeys, type TrendPoint } from "./trends";

// Categorical slots, in fixed order and never cycled. Adjacent pairs clear the
// colour-vision separation target (ΔE 9.1, target ≥ 8) and normal-vision floor
// (19.6, floor 15) — checked with the dataviz validator. Three of the eight sit
// under 3:1 contrast on white, so the exact figures are always in the table
// directly below each chart and in the hover card.
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const MAX_COMPANY_LINES = SERIES_COLORS.length;
/** Every company line's key starts with this, so the tooltip can tell it from a group line. */
export const COMPANY_KEY = "co:";
const DEFAULT_COMPANIES = 5;
/** The group total / the plan: neutral ink, so it never competes with a company's colour. */
export const TOTAL_INK = "#14161A";

export interface TrendLine {
  key: string;
  /** Legend and chip text. */
  label: string;
  /** Fuller name for the hover card (a company's full legal name). */
  title?: string;
  color: string;
  dashed?: boolean;
  width?: number;
  points: Map<string, TrendPoint>;
}

export type TrendCandidate = Omit<TrendLine, "color">;

interface Props {
  title: string;
  note: ReactNode;
  labels: string[];
  /** Always drawn: the group total, or budget and actual. */
  fixed: TrendLine[];
  /** Companies the viewer may add to the chart. */
  candidates?: TrendCandidate[];
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  /** The period picked in the controls bar. */
  selectedLabel?: string;
  right?: ReactNode;
  footnote?: ReactNode;
  /** Benchmark lines, e.g. the PAT-margin band edges. */
  refLines?: { y: number; label: string }[];
  height?: number;
  /** Draw the fixed lines as side-by-side bars per period (budget against actual) instead of lines. */
  bars?: boolean;
}

export default function TrendChart({
  title, note, labels: allLabels, fixed, candidates = [], fmt, axisFmt, selectedLabel, right, footnote, refLines = [], height = 280, bars = false,
}: Props) {
  // Up to and including the picked period. Labels arrive in date order, so a cut
  // by position is a cut by date. A pick the chart has no point for (a period
  // none of its series covers) leaves the full range rather than an empty one.
  const labels = useMemo(() => labelsUpTo(allLabels, selectedLabel), [allLabels, selectedLabel]);

  const present = useMemo(() => new Set(candidates.map((c) => c.key)), [candidates]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const colors = useRef(new Map<string, string>());

  const ranked = useMemo(
    () => topKeys(candidates, rankLabel(labels, selectedLabel ?? "", candidates.map((c) => c.points)), DEFAULT_COMPANIES),
    [candidates, labels, selectedLabel]);

  // What the viewer chose, limited to companies still in the list (the group
  // filter can remove some); the biggest few until they choose.
  const stillThere = picked?.filter((k) => present.has(k)) ?? [];
  const selected = picked == null || (stillThere.length === 0 && picked.length > 0) ? ranked : stillThere;

  // A company keeps its colour while it is on the chart. A colour is reassigned
  // only when two companies on screen would share one.
  const colorOf = useMemo(() => {
    const map = colors.current;
    const used = new Set<string>();
    for (const k of selected) {
      const c = map.get(k);
      if (c && !used.has(c)) used.add(c);
      else map.delete(k);
    }
    for (const k of selected) {
      if (!map.has(k)) {
        const c = SERIES_COLORS.find((x) => !used.has(x)) ?? SERIES_COLORS[0];
        map.set(k, c);
        used.add(c);
      }
    }
    return new Map(selected.map((k) => [k, map.get(k)!] as const));
  }, [selected]);

  const companyLines: TrendLine[] = selected
    .map((k) => candidates.find((c) => c.key === k))
    .filter((c): c is TrendCandidate => !!c)
    .map((c) => ({ ...c, color: colorOf.get(c.key)! }));
  const lines = [...fixed, ...companyLines];

  const data = useMemo(() => labels.map((l) => {
    const row: Record<string, string | number | boolean | null> = { label: l };
    for (const ln of lines) {
      const p = ln.points.get(l);
      row[ln.key] = p?.value ?? null;
      row[`${ln.key}__partial`] = p != null && p.value != null && p.n < p.of;
    }
    return row;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [labels, fixed, selected, candidates]);

  const hasValue = lines.some((ln) => labels.some((l) => ln.points.get(l)?.value != null));
  const hasPartial = fixed.some((ln) => labels.some((l) => { const p = ln.points.get(l); return p?.value != null && p.n < p.of; }));

  const toggle = (key: string) => {
    const on = selected.includes(key);
    if (!on && selected.length >= MAX_COMPANY_LINES) return;
    setPicked(on ? selected.filter((k) => k !== key) : [...selected, key]);
  };

  return (
    <Card title={title} note={undefined} right={right}>
      <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">
        {note}
        {selectedLabel && labels.includes(selectedLabel) && <> The chart runs up to <b>{selectedLabel}</b>, the period picked above.</>}
      </p>

      {!hasValue ? (
        <EmptyState>Nothing to plot for these periods yet.</EmptyState>
      ) : (
        bars ? (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} margin={{ top: 10, right: 14, left: 4, bottom: 0 }} barGap={3} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false}
              axisLine={{ stroke: GRID_LINE_COLOR }} interval="preserveStartEnd" minTickGap={16} />
            {/* Bars start at zero: a truncated axis would exaggerate the gap between plan and actual. */}
            <YAxis tickFormatter={axisFmt ?? fmt} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false}
              width={72} domain={[(m: number) => Math.min(0, m), "auto"]} />
            <Tooltip cursor={{ fill: "rgba(20,22,26,0.05)" }}
              content={(p: any) => <TrendTip active={p?.active} label={p?.label} lines={lines} fmt={fmt} />} />
            {lines.map((ln) => (
              <Bar key={ln.key} dataKey={ln.key} name={ln.label} fill={ln.color} radius={[3, 3, 0, 0]} maxBarSize={34} isAnimationActive={false}>
                {data.map((d, i) => <Cell key={i} fill={ln.color} fillOpacity={d[`${ln.key}__partial`] ? 0.45 : 1} />)}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
        ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data} margin={{ top: 10, right: 14, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false}
              axisLine={{ stroke: GRID_LINE_COLOR }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tickFormatter={axisFmt ?? fmt} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false}
              width={72} domain={["auto", "auto"]} />
            {refLines.map((r) => (
              <ReferenceLine key={r.label} y={r.y} stroke={AXIS_TEXT_COLOR} strokeOpacity={0.55} strokeDasharray="2 4"
                label={{ value: r.label, position: "insideBottomRight", fontSize: 10, fill: AXIS_TEXT_COLOR }} />
            ))}
            <Tooltip cursor={{ stroke: AXIS_TEXT_COLOR, strokeDasharray: "3 3" }}
              content={(p: any) => <TrendTip active={p?.active} label={p?.label} lines={lines} fmt={fmt} />} />
            {lines.map((ln) => (
              <Line key={ln.key} dataKey={ln.key} name={ln.label} stroke={ln.color} strokeWidth={ln.width ?? 2}
                strokeDasharray={ln.dashed ? "6 4" : undefined} connectNulls={false} isAnimationActive={false}
                dot={(d: any) => {
                  if (d?.cx == null || d?.cy == null || d.value == null) return <g key={d?.key ?? d?.index} />;
                  const partial = d.payload?.[`${ln.key}__partial`];
                  return (
                    <circle key={d.key ?? d.index} cx={d.cx} cy={d.cy} r={3.5} stroke={ln.color} strokeWidth={2}
                      fill={partial ? "#FFFFFF" : ln.color} />
                  );
                }}
                activeDot={{ r: 5, stroke: "#FFFFFF", strokeWidth: 2, fill: ln.color }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        )
      )}

      {/* Legend — always present, identity is never colour alone. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 pt-3 border-t border-gray-50">
        {fixed.map((ln) => (
          <span key={ln.key} className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
            <Swatch color={ln.color} dashed={ln.dashed} />
            {ln.label}
          </span>
        ))}
      </div>

      {candidates.length > 0 && (
        <div className="no-print mt-3">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Companies on the chart · {selected.length} of up to {MAX_COMPANY_LINES}
            </span>
            <span className="flex items-center gap-3 text-[11px]">
              <button onClick={() => setPicked(ranked)} className="font-semibold text-brand-orange hover:underline">Biggest {DEFAULT_COMPANIES}</button>
              <button onClick={() => setPicked([])} className="font-semibold text-gray-500 hover:underline">Clear</button>
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {candidates.map((c) => {
              const on = selected.includes(c.key);
              const full = !on && selected.length >= MAX_COMPANY_LINES;
              return (
                <button key={c.key} onClick={() => toggle(c.key)} disabled={full}
                  title={full ? `Up to ${MAX_COMPANY_LINES} companies at a time — remove one first` : c.title ?? c.label}
                  className={`flex items-center gap-1.5 text-[11px] font-semibold rounded-full border px-2.5 py-1 transition-colors ${
                    on ? "border-gray-300 bg-white text-gray-800" : "border-gray-200 bg-transparent text-gray-500 hover:text-gray-800"
                  } ${full ? "opacity-40 cursor-not-allowed" : ""}`}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0 border"
                    style={on ? { background: colorOf.get(c.key), borderColor: colorOf.get(c.key) } : { borderColor: "#C9C3B8" }} />
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(hasPartial || footnote) && (
        <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
          {footnote}
          {hasPartial && bars && <> A <b>paler bar</b> means the total covers only some of the companies for that period — hover for how many.</>}
          {hasPartial && !bars && <> A <b>hollow dot</b> means the total covers only some of the companies for that period — usually the
            latest months, which fill in as each company reports, so a dip there is not a fall. Hover for how many.</>}
        </p>
      )}
    </Card>
  );
}

function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width="22" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? "5 3" : undefined} strokeLinecap="round" />
    </svg>
  );
}

function TrendTip({ active, label, lines, fmt }: { active?: boolean; label?: string; lines: TrendLine[]; fmt: (v: number) => string }) {
  if (!active || !label) return null;
  const rows = lines
    .map((ln) => ({ ln, p: ln.points.get(label) }))
    .filter((r) => r.p?.value != null);
  if (rows.length === 0) return null;
  // The group lines read first, then the companies, biggest first.
  const ordered = [
    ...rows.filter((r) => !r.ln.key.startsWith(COMPANY_KEY)),
    ...rows.filter((r) => r.ln.key.startsWith(COMPANY_KEY)).sort((a, b) => (b.p!.value as number) - (a.p!.value as number)),
  ];
  return (
    <div className="bg-white border border-[#EAE3D6] rounded-xl shadow-lg px-3 py-2 text-[12px] min-w-[220px] max-w-[320px]">
      <div className="font-bold text-gray-800 mb-1">{label}</div>
      {ordered.map(({ ln, p }) => (
        <div key={ln.key} className="flex items-start justify-between gap-4 py-0.5">
          <span className="flex items-start gap-1.5 text-gray-600">
            <span className="mt-1.5 shrink-0"><Swatch color={ln.color} dashed={ln.dashed} /></span>
            <span>{ln.title ?? ln.label}{p!.of > 1 && p!.n < p!.of && (
              <span className="block text-[10px] text-gray-500">{p!.n} of {p!.of} companies reported</span>
            )}</span>
          </span>
          <span className="tabular-nums font-semibold text-gray-800 whitespace-nowrap">{fmt(p!.value as number)}</span>
        </div>
      ))}
    </div>
  );
}
