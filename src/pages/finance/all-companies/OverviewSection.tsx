// The Overview at the top of All Companies: the headline figures of the group for the
// picked period, and two pictures of who is carrying it.
//
// Everything here is built from the same rules as the tables below — roll-up
// companies are left out, a total is over the companies that reported, the margin is
// total PAT over total Sales — so a tile always agrees with the Total row it
// summarises. The change under a tile compares the SAME companies in both periods
// (those with a figure in each), so a company that simply had not reported last
// period cannot make the group look as if it grew.
import { useMemo } from "react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie } from "recharts";
import { Card, EmptyState, bucketValue } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { AXIS_TEXT_COLOR, GRID_LINE_COLOR, formatCompact, formatINR } from "../format";
import { MARGIN_BANDS, classifyMargin, netPatMargin } from "../margin";
import { fmtMoney, totalled, type ConsolidatedCompany } from "./shared";
import { sumColumn, sumTogether, totalMargin } from "./totals";
import { SERIES_COLORS } from "./TrendChart";
import { slugOf } from "../budgetMath";
import Sparkline from "../shared/Sparkline";
import { labelsFor, labelsUpTo, sumByLabel, toMap } from "./trends";
import { SUCCESS_COLOR, DANGER_COLOR, NEUTRAL_COLOR } from "../format";

interface Props { companies: ConsolidatedCompany[]; view: TrendView; bucket: string; prevBucket: string | null }

const TOP_N = 10;
const shortName = (c: ConsolidatedCompany) => c.short_label || c.label;

/** % change of a total between two periods, over the companies that have both. */
function pairedChange(pairs: { cur: number | null; prev: number | null }[]): number | null {
  const both = pairs.filter((p): p is { cur: number; prev: number } => p.cur != null && p.prev != null);
  if (both.length === 0) return null;
  const cur = both.reduce((s, p) => s + p.cur, 0);
  const prev = both.reduce((s, p) => s + p.prev, 0);
  return prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;
}


const BUDGET_LINES = [
  { key: "revenue", label: "Revenue", slugs: ["revanue_income", "revenue_income"] },
  { key: "pbitda", label: "PBITDA", slugs: ["pbitda"] },
  { key: "pat", label: "PAT", slugs: ["pat"] },
] as const;

const SPARK_POINTS = 7;

/** A headline tile: the figure, its change on the previous period, and a sparkline of the recent periods. */
function StatTile({ label, value, exact, delta, deltaUnit = "%", vs, accent, spark, badge }: {
  label: string; value: string; exact?: string; delta: number | null; deltaUnit?: "%" | "pts"; vs: string | null;
  accent: string; spark: number[]; badge?: { text: string; bg: string; fg: string } | null;
}) {
  const up = delta != null && delta >= 0;
  return (
    <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-4 overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: accent }} />
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</div>
      <div className="flex items-end justify-between gap-2 mt-1">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-bold text-gray-800 tracking-tight" title={exact}>{value}</span>
            {badge && <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: badge.bg, color: badge.fg }}>{badge.text}</span>}
          </div>
          {delta != null ? (
            <div className="text-[11px] font-semibold mt-0.5" style={{ color: up ? SUCCESS_COLOR : DANGER_COLOR }}>
              {up ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}{deltaUnit === "pts" ? " pts" : "%"}
              {vs && <span className="text-gray-500 font-medium"> · {vs}</span>}
            </div>
          ) : <div className="text-[11px] text-gray-400 mt-0.5">no earlier period to compare</div>}
        </div>
        <div className="shrink-0 pb-1"><Sparkline values={spark} width={64} height={26} color={accent} /></div>
      </div>
    </div>
  );
}

const pctOf = (v: number | null, base: number | null) => (v != null && base != null && base > 0 ? (v / base) * 100 : null);

export default function OverviewSection({ companies, view, bucket, prevBucket }: Props) {
  const eligible = useMemo(() => totalled(companies), [companies]);

  const rows = useMemo(() => eligible.map((c) => {
    const at = (s: ConsolidatedCompany["pl"]["sales"], b: string | null, kind: "flow" | "stock" = "flow") =>
      b ? bucketValue(s, kind, view, b) : null;
    return {
      c,
      sales: at(c.pl.sales, bucket), gross: at(c.pl.gross, bucket), pbitda: at(c.pl.pbitda, bucket), pat: at(c.pl.pat, bucket),
      pSales: at(c.pl.sales, prevBucket), pGross: at(c.pl.gross, prevBucket), pPbitda: at(c.pl.pbitda, prevBucket), pPat: at(c.pl.pat, prevBucket),
      nwc: at(c.wc.nwc, bucket, "stock"), pNwc: at(c.wc.nwc, prevBucket, "stock"),
    };
  }), [eligible, view, bucket, prevBucket]);

  const sales = sumColumn(rows.map((r) => r.sales));
  const gross = sumColumn(rows.map((r) => r.gross));
  const pbitda = sumColumn(rows.map((r) => r.pbitda));
  const pat = sumColumn(rows.map((r) => r.pat));
  const nwc = sumColumn(rows.map((r) => r.nwc));
  const margin = totalMargin(rows.map((r) => ({ sales: r.sales, pat: r.pat })));
  const band = classifyMargin(margin);

  // Margin change in percentage points, over the companies that report both figures in both periods.
  const prevMargin = (() => {
    const t = sumTogether(rows.map((r) => [r.pSales, r.pPat]));
    return netPatMargin(t.values[0], t.values[1]);
  })();
  const marginPp = margin != null && prevMargin != null ? (margin - prevMargin) * 100 : null;

  const vs = prevBucket ? `vs ${prevBucket}` : null;
  const change = (cur: "sales" | "gross" | "pbitda" | "pat" | "nwc", prev: "pSales" | "pGross" | "pPbitda" | "pPat" | "pNwc") =>
    pairedChange(rows.map((r) => ({ cur: r[cur], prev: r[prev] })));

  // The last few periods of each group total, for the sparklines — up to the picked period only.
  const sparks = useMemo(() => {
    const labels = labelsUpTo(labelsFor(eligible.map((c) => c.pl.sales), "flow", view), bucket);
    const line = (pick: (c: ConsolidatedCompany) => ConsolidatedCompany["pl"]["sales"]) => {
      const pts = sumByLabel(labels, eligible.map((c) => toMap(pick(c), "flow", view)));
      return labels.map((l) => pts.get(l)?.value).filter((v): v is number => v != null).slice(-SPARK_POINTS);
    };
    const salesMaps = eligible.map((c) => toMap(c.pl.sales, "flow", view));
    const patMaps = eligible.map((c) => toMap(c.pl.pat, "flow", view));
    const marginLine = labels.map((l) => {
      const t = sumTogether(eligible.map((_, i) => [salesMaps[i].get(l), patMaps[i].get(l)]));
      const m = netPatMargin(t.values[0], t.values[1]);
      return m == null ? null : m * 100;
    }).filter((v): v is number => v != null).slice(-SPARK_POINTS);
    const nwcLabels = labelsUpTo(labelsFor(eligible.map((c) => c.wc.nwc), "stock", view), bucket);
    const nwcPts = sumByLabel(nwcLabels, eligible.map((c) => toMap(c.wc.nwc, "stock", view)));
    return {
      sales: line((c) => c.pl.sales), gross: line((c) => c.pl.gross), pbitda: line((c) => c.pl.pbitda), pat: line((c) => c.pl.pat),
      margin: marginLine,
      nwc: nwcLabels.map((l) => nwcPts.get(l)?.value).filter((v): v is number => v != null).slice(-SPARK_POINTS),
    };
  }, [eligible, view, bucket]);

  // Who is carrying the group: the biggest companies by Sales this period.
  const ranked = useMemo(() => rows
    .filter((r) => r.sales != null && r.sales > 0)
    .sort((a, b) => (b.sales as number) - (a.sales as number)), [rows]);
  const salesTotal = sales.value ?? 0;
  const top = ranked.slice(0, TOP_N).map((r) => ({ name: shortName(r.c), full: r.c.label, sales: r.sales as number, pat: r.pat }));

  // Share of group Sales: the six biggest and the rest together.
  const share = useMemo(() => {
    const head = ranked.slice(0, 6).map((r, i) => ({ name: shortName(r.c), full: r.c.label, value: r.sales as number, fill: SERIES_COLORS[i] }));
    const rest = ranked.slice(6).reduce((s, r) => s + (r.sales as number), 0);
    return rest > 0 ? [...head, { name: `Other ${ranked.length - 6}`, full: `${ranked.length - 6} other companies`, value: rest, fill: "#B8B2A6" }] : head;
  }, [ranked]);

  // How profit builds down from Sales: each step's size and its share of Sales.
  const funnel = [
    { label: "Net Sales", value: sales.value, fill: SERIES_COLORS[0] },
    { label: "Gross Margin", value: gross.value, fill: SERIES_COLORS[2] },
    { label: "PBITDA", value: pbitda.value, fill: SERIES_COLORS[3] },
    { label: "PAT", value: pat.value, fill: SERIES_COLORS[1] },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => Math.abs(f.value ?? 0)));

  // Budget achievement for the period — over the companies that have BOTH a plan and an actual.
  const budget = useMemo(() => BUDGET_LINES.map((m) => {
    const pairs = eligible.map((c) => {
      const li = c.budget?.lines.find((l) => (m.slugs as readonly string[]).includes(slugOf(l.line_key)));
      return [li ? bucketValue(li.series, "flow", view, bucket) : null,
        li ? bucketValue(c.budget!.actuals[li.line_key]?.series ?? [], "flow", view, bucket) : null];
    });
    const t = sumTogether(pairs);
    return { ...m, plan: t.values[0] ?? null, actual: t.values[1] ?? null, n: t.n };
  }), [eligible, view, bucket]);

  // How the companies sit against the PAT-margin bands the page classifies by.
  const bandMix = useMemo(() => {
    const counts = new Map<string, number>(MARGIN_BANDS.map((b) => [b.key, 0]));
    let classified = 0;
    for (const r of rows) {
      const b = classifyMargin(netPatMargin(r.sales, r.pat));
      if (b) { counts.set(b.key, (counts.get(b.key) ?? 0) + 1); classified++; }
    }
    return { classified, bands: MARGIN_BANDS.map((b) => ({ ...b, count: counts.get(b.key) ?? 0 })) };
  }, [rows]);

  // Things worth a look this period, worst first.
  const attention = useMemo(() => {
    const out: { sev: number; who: string; text: string }[] = [];
    for (const r of rows) {
      const m = netPatMargin(r.sales, r.pat);
      const b = classifyMargin(m);
      if (m != null && b && m < 0.04) out.push({ sev: m < 0 ? 3 : 2, who: shortName(r.c), text: `PAT margin ${(m * 100).toFixed(1)}% — ${b.label} band` });
      if (r.sales != null && r.pSales != null && r.pSales > 0) {
        const d = ((r.sales - r.pSales) / r.pSales) * 100;
        if (d <= -15) out.push({ sev: 2, who: shortName(r.c), text: `Sales down ${Math.abs(d).toFixed(0)}%${prevBucket ? ` vs ${prevBucket}` : ""}` });
      }
      const li = r.c.budget?.lines.find((l) => (BUDGET_LINES[0].slugs as readonly string[]).includes(slugOf(l.line_key)));
      if (li) {
        const plan = bucketValue(li.series, "flow", view, bucket);
        const act = bucketValue(r.c.budget!.actuals[li.line_key]?.series ?? [], "flow", view, bucket);
        if (plan != null && act != null && plan > 0 && act / plan < 0.9) {
          out.push({ sev: 1, who: shortName(r.c), text: `Revenue ${((act / plan) * 100).toFixed(0)}% of budget` });
        }
      }
    }
    return out.sort((a, b) => b.sev - a.sev).slice(0, 8);
  }, [rows, view, bucket, prevBucket]);

  if (rows.length === 0) return <EmptyState>No companies to summarise here.</EmptyState>;

  const barTip = (p: { active?: boolean; payload?: { payload: (typeof top)[number] }[] }) => {
    const d = p.active ? p.payload?.[0]?.payload : null;
    if (!d) return null;
    return (
      <div className="bg-white border border-[#EAE3D6] rounded-xl shadow-lg px-3 py-2 text-[12px] max-w-[300px]">
        <div className="font-bold text-gray-800 mb-1">{d.full}</div>
        <div className="flex justify-between gap-4"><span className="text-gray-600">Sales</span>
          <span className="font-semibold tabular-nums">{formatINR(d.sales)}</span></div>
        {salesTotal > 0 && <div className="flex justify-between gap-4"><span className="text-gray-600">Share of group</span>
          <span className="font-semibold tabular-nums">{((d.sales / salesTotal) * 100).toFixed(1)}%</span></div>}
        {d.pat != null && <div className="flex justify-between gap-4"><span className="text-gray-600">PAT</span>
          <span className="font-semibold tabular-nums">{formatINR(d.pat)}</span></div>}
      </div>
    );
  };
  const pieTip = (p: { active?: boolean; payload?: { payload: (typeof share)[number] }[] }) => {
    const d = p.active ? p.payload?.[0]?.payload : null;
    if (!d) return null;
    return (
      <div className="bg-white border border-[#EAE3D6] rounded-xl shadow-lg px-3 py-2 text-[12px] max-w-[260px]">
        <div className="font-bold text-gray-800">{d.full}</div>
        <div className="tabular-nums text-gray-600">{formatINR(d.value)} · {salesTotal > 0 ? ((d.value / salesTotal) * 100).toFixed(1) : "—"}%</div>
      </div>
    );
  };
  const chip = (v: number | null, color: string, fg: string) =>
    (v == null ? null : { text: `${v.toFixed(1)}%`, bg: color, fg });

  return (
    <div className="flex flex-col gap-4">
      {/* Headline tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile label="Net Sales" value={fmtMoney(sales.value)} exact={sales.value != null ? formatINR(sales.value) : undefined}
          delta={change("sales", "pSales")} vs={vs} accent={SERIES_COLORS[0]} spark={sparks.sales} />
        <StatTile label="Gross Margin" value={fmtMoney(gross.value)} exact={gross.value != null ? formatINR(gross.value) : undefined}
          delta={change("gross", "pGross")} vs={vs} accent={SERIES_COLORS[2]} spark={sparks.gross}
          badge={chip(pctOf(gross.value, sales.value), `${SERIES_COLORS[2]}1A`, SERIES_COLORS[2])} />
        <StatTile label="PBITDA" value={fmtMoney(pbitda.value)} exact={pbitda.value != null ? formatINR(pbitda.value) : undefined}
          delta={change("pbitda", "pPbitda")} vs={vs} accent={SERIES_COLORS[3]} spark={sparks.pbitda}
          badge={chip(pctOf(pbitda.value, sales.value), `${SERIES_COLORS[3]}22`, "#8A5A00")} />
        <StatTile label="PAT" value={fmtMoney(pat.value)} exact={pat.value != null ? formatINR(pat.value) : undefined}
          delta={change("pat", "pPat")} vs={vs} accent={SERIES_COLORS[1]} spark={sparks.pat} />
        <StatTile label="PAT Margin" value={margin == null ? "—" : `${(margin * 100).toFixed(1)}%`}
          delta={marginPp} deltaUnit="pts" vs={vs} accent={band?.bg ?? SERIES_COLORS[6]} spark={sparks.margin}
          badge={band ? { text: band.label, bg: band.bg, fg: band.fg } : null} />
        <StatTile label="Net Working Capital" value={fmtMoney(nwc.value)} exact={nwc.value != null ? formatINR(nwc.value) : undefined}
          delta={change("nwc", "pNwc")} vs={vs} accent={SERIES_COLORS[6]} spark={sparks.nwc} />
      </div>
      <p className="text-[11px] text-gray-500 -mt-1">
        Group totals for <b>{bucket || "the period"}</b> over the {sales.n} of {rows.length} companies that reported Sales; roll-ups are left out.
        The small chip is the share of Sales. Each change compares the same companies in both periods; the line shows the last {SPARK_POINTS} periods.
        Net Working Capital is the position at the period's close.
      </p>

      {/* Profit build-down | share of sales | budget */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="From Sales to PAT" note="Each step of the group's profit, and what share of Sales it keeps.">
          <div className="flex flex-col gap-3 mt-2">
            {funnel.map((f) => {
              const pct = pctOf(f.value, sales.value);
              return (
                <div key={f.label}>
                  <div className="flex items-baseline justify-between text-[12px] mb-1">
                    <span className="font-semibold text-gray-700">{f.label}</span>
                    <span className="tabular-nums text-gray-800">
                      <b>{fmtMoney(f.value)}</b>{pct != null && f.label !== "Net Sales" && <span className="text-gray-500"> · {pct.toFixed(1)}%</span>}
                    </span>
                  </div>
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full"
                      style={{ width: `${Math.min(100, (Math.abs(f.value ?? 0) / funnelMax) * 100)}%`, background: (f.value ?? 0) < 0 ? DANGER_COLOR : f.fill }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Share of Sales" note={`How ${bucket || "the period"}'s Sales splits across companies.`}>
          {share.length === 0 ? <EmptyState>No Sales reported for this period.</EmptyState> : (
            <div className="flex items-center gap-3">
              <div className="relative shrink-0" style={{ width: 150, height: 150 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={share} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} paddingAngle={2} stroke="none" isAnimationActive={false}>
                      {share.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Pie>
                    <Tooltip content={pieTip as never} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Sales</span>
                  <span className="text-[13px] font-bold text-gray-800">{fmtMoney(sales.value)}</span>
                </div>
              </div>
              <ul className="flex-1 min-w-0 flex flex-col gap-1">
                {share.map((d) => (
                  <li key={d.name} className="flex items-center gap-2 text-[11px]" title={d.full}>
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.fill }} />
                    <span className="truncate text-gray-700">{d.name}</span>
                    <span className="ml-auto tabular-nums font-semibold text-gray-800">{salesTotal > 0 ? ((d.value / salesTotal) * 100).toFixed(0) : "—"}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card title="Budget achievement" note={`Actual against plan for ${bucket || "the period"}, over the companies that have both.`}>
          <div className="flex flex-col gap-3 mt-2">
            {budget.map((b) => {
              const pct = b.plan != null && b.actual != null && b.plan > 0 ? (b.actual / b.plan) * 100 : null;
              const color = pct == null ? NEUTRAL_COLOR : pct >= 100 ? SUCCESS_COLOR : pct >= 90 ? "#EDA100" : DANGER_COLOR;
              return (
                <div key={b.key}>
                  <div className="flex items-baseline justify-between text-[12px] mb-1">
                    <span className="font-semibold text-gray-700">{b.label}</span>
                    <span className="tabular-nums text-gray-800">
                      {pct == null ? <span className="text-gray-400">no budget this period</span>
                        : <><b style={{ color }}>{pct.toFixed(0)}%</b><span className="text-gray-500"> · {fmtMoney(b.actual)} of {fmtMoney(b.plan)}</span></>}
                    </span>
                  </div>
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: color }} />
                  </div>
                </div>
              );
            })}
            <p className="text-[11px] text-gray-500">{budget[0].n > 0 ? `${budget[0].n} companies have a Revenue budget and actual.` : "No company has a budget for this period."}</p>
          </div>
        </Card>
      </div>

      {/* Leaders | needs attention + margin bands */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card title={`Top ${Math.min(TOP_N, top.length) || TOP_N} companies by Sales`}>
            {top.length === 0 ? <EmptyState>No Sales reported for this period.</EmptyState> : (
              <ResponsiveContainer width="100%" height={Math.max(180, top.length * 30 + 20)}>
                <BarChart data={top} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 0 }} barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => formatCompact(v)} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }}
                    tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: "rgba(20,22,26,0.05)" }} content={barTip as never} />
                  <Bar dataKey="sales" radius={[0, 4, 4, 0]} isAnimationActive={false}
                    label={{ position: "right", fontSize: 11, fill: AXIS_TEXT_COLOR, formatter: (v: number) => formatCompact(v) }}>
                    {top.map((_, i) => <Cell key={i} fill={SERIES_COLORS[0]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Needs attention" note="Margins under 4%, Sales down 15% or more, Revenue under 90% of budget.">
            {attention.length === 0 ? (
              <p className="text-[12px] font-semibold" style={{ color: SUCCESS_COLOR }}>Nothing flagged for {bucket || "this period"}.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {attention.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px]">
                    <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: a.sev >= 3 ? DANGER_COLOR : a.sev === 2 ? "#EB6834" : "#EDA100" }} />
                    <span className="text-gray-700"><b className="text-gray-800">{a.who}</b> · {a.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Companies by PAT-margin band"
            note={`${bandMix.classified} of ${rows.length} companies have Sales and PAT for ${bucket || "the period"}.`}>
            {bandMix.classified === 0 ? <EmptyState>Nothing to classify yet.</EmptyState> : (
              <div className="flex flex-col gap-2 mt-1">
                {bandMix.bands.map((b) => (
                  <div key={b.key} className="flex items-center gap-2">
                    <span className="w-[72px] shrink-0 text-[11px] font-bold rounded-md px-1.5 py-0.5 text-center"
                      style={{ background: b.bg, color: b.fg }} title={b.range}>{b.label}</span>
                    <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(b.count / bandMix.classified) * 100}%`, background: b.bg }} />
                    </div>
                    <span className="w-6 text-right text-[12px] font-semibold tabular-nums text-gray-700">{b.count}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
