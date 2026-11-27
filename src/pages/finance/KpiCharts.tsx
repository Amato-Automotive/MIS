// A line / bar chart for each KPI tile on the company Highlights tab, drawn
// straight under the tiles so a figure and its history are read together.
// Same numbers as the tiles: flow figures are period totals, cash and working
// capital are the closing position, PAT margin is PAT ÷ Sales per period.
import { useMemo, useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendView } from "./aggregate";
import { netPatMargin } from "./margin";
import { fmtMoney, type ConsolidatedCompany } from "./all-companies/shared";
import { SERIES_COLORS } from "./all-companies/TrendChart";
import { labelsFor, labelsUpTo, toMap } from "./all-companies/trends";

type Mode = "both" | "line" | "bar";
const MODES: [Mode, string][] = [["both", "Bar + line"], ["bar", "Bar"], ["line", "Line"]];
const MAX_POINTS = 12;

interface Kpi { key: string; title: string; color: string; fmt: (v: number) => string; data: { label: string; value: number | null }[] }

export default function KpiCharts({ c, view, bucket }: { c: ConsolidatedCompany; view: TrendView; bucket: string }) {
  const [mode, setMode] = useState<Mode>("both");

  const kpis: Kpi[] = useMemo(() => {
    const all = labelsFor([c.pl.sales, c.pl.pbitda, c.pl.pat], "flow", view);
    const labels = labelsUpTo(all, bucket).slice(-MAX_POINTS);
    const series = (s: ConsolidatedCompany["pl"]["sales"] | undefined, kind: "flow" | "stock") => {
      const m = toMap(s, kind, view);
      return labels.map((label) => ({ label, value: m.get(label) ?? null }));
    };
    const sm = toMap(c.pl.sales, "flow", view); const pm = toMap(c.pl.pat, "flow", view);
    const pct = (v: number) => `${v.toFixed(1)}%`;
    return [
      { key: "sales", title: "Net Sales", color: SERIES_COLORS[0], fmt: fmtMoney, data: series(c.pl.sales, "flow") },
      { key: "pbitda", title: "PBITDA", color: SERIES_COLORS[3], fmt: fmtMoney, data: series(c.pl.pbitda, "flow") },
      { key: "pat", title: "PAT", color: SERIES_COLORS[1], fmt: fmtMoney, data: series(c.pl.pat, "flow") },
      { key: "margin", title: "PAT Margin", color: SERIES_COLORS[6], fmt: pct,
        data: labels.map((label) => { const m = netPatMargin(sm.get(label) ?? null, pm.get(label) ?? null); return { label, value: m == null ? null : m * 100 }; }) },
      { key: "cash", title: "Cash & Bank", color: SERIES_COLORS[2], fmt: fmtMoney, data: series(c.wc?.cash, "stock") },
      { key: "nwc", title: "Net Working Capital", color: SERIES_COLORS[5], fmt: fmtMoney, data: series(c.wc?.nwc, "stock") },
    ];
  }, [c, view, bucket]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-bold text-gray-700">How each figure has moved · last {Math.min(MAX_POINTS, kpis[0]?.data.length ?? 0)} periods up to {bucket}</span>
        <div className="inline-flex rounded-lg border border-[#E5DECF] overflow-hidden">
          {MODES.map(([m, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-[11px] font-semibold ${mode === m ? "bg-gray-800 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {kpis.map((k) => <KpiChart key={k.key} k={k} mode={mode} bucket={bucket} />)}
      </div>
    </div>
  );
}

function KpiChart({ k, mode, bucket }: { k: Kpi; mode: Mode; bucket: string }) {
  const has = k.data.some((d) => d.value != null);
  return (
    <div className="bg-white border border-[#E5DECF] rounded-xl p-3">
      <div className="text-[12px] font-bold text-gray-800 mb-1">{k.title}</div>
      {!has ? <div className="h-[170px] flex items-center justify-center text-[12px] text-gray-400">No figures</div> : (
        <div className="h-[170px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={k.data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F0EBDD" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#6B7280" }} tickLine={false} axisLine={{ stroke: "#E5DECF" }} interval="preserveStartEnd" minTickGap={14} />
              <YAxis tick={{ fontSize: 10, fill: "#6B7280" }} tickLine={false} axisLine={false} width={48}
                tickFormatter={(v: number) => k.fmt(v)} />
              <Tooltip formatter={(v: unknown) => (typeof v === "number" ? k.fmt(v) : "—")} labelStyle={{ fontWeight: 700 }}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #E5DECF" }} cursor={{ fill: "#00000008" }} />
              {mode !== "line" && (
                <Bar dataKey="value" name={k.title} radius={[3, 3, 0, 0]} maxBarSize={26} isAnimationActive={false}>
                  {k.data.map((d) => <Cell key={d.label} fill={k.color} fillOpacity={d.label === bucket ? 1 : mode === "both" ? 0.35 : 0.6} />)}
                </Bar>
              )}
              {mode !== "bar" && (
                <Line dataKey="value" name={k.title} type="monotone" stroke={mode === "both" ? "#14161A" : k.color} strokeWidth={2}
                  dot={{ r: 2.5 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
