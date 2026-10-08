// OEM Targets — the brand-level commitment for the financial year.
//
// Reads /oe-network/oem-targets. Its source is one workbook per FY with a tab
// per OEM, and the thing that shapes this whole tab is that the workbook is
// LOPSIDED IN TIME: every month of the year carries a target from the day it is
// published, but achievement lands one month at a time.
//
// So "achieved ÷ target" is two different questions and the tab shows both,
// labelled:
//   PACE     achieved ÷ the target of the months that have been published.
//            The performance figure. In August a brand exactly on plan reads
//            100% here.
//   PROGRESS achieved ÷ the whole selected period's target. In August that same
//            brand reads about 40%, because most of its year has not happened.
// Showing only the second — the obvious one to compute — would have every OEM
// looking catastrophically behind for eleven months of every year.
//
// Not the same tab as Salesperson Targets. That one reads the quarterly
// workbook where the year's money is split between people. This is the number
// agreed with the brand. Two files, two commitments; they are never added.
import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LabelList,
} from "recharts";
import { Target, TrendingUp, Percent, Building2 } from "lucide-react";
import Select from "@/components/ui/Select";
import { formatCompact, formatCompactNos } from "@/lib/format";
import {
  API_URL, MONTH_SHORT, VISIT_COLOR, NEUTRAL_BAR, CHART_LABEL, ON_TRACK_PCT,
  periodParams, PeriodControls, usePeriod,
  FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, SyncButton, FILTER_LABELS, filterOpts,
  shortDate, categoryLabel, StatCard, KPI, achColor, BulletChart, useSyncLatest,
  type BulletDatum,
} from "./shared";
import Explain from "./dealers/Explain";

type Metric = "value" | "nos";

/** Every figure carries units AND money side by side, and they diverge — the
 *  tab toggles between them without refetching and neither is "the" number. */
interface OemMetrics {
  tgt_nos: number | null; tgt_value: number | null;
  ach_nos: number | null; ach_value: number | null;
  /** The target of the PUBLISHED months only — the honest denominator. */
  tgt_nos_todate: number | null; tgt_value_todate: number | null;
  pace_pct_nos: number | null; pace_pct_value: number | null;
  year_pct_nos: number | null; year_pct_value: number | null;
  gap_nos: number | null; gap_value: number | null;
  months_total: number; months_published: number;
}
interface OemGroup extends OemMetrics { key: string }
interface OemProductRow extends OemMetrics { oem: string; key: string; product_key: string }
interface OemSummary {
  fy_year: number | null;
  label: string;
  /** True when a custom DAY range was widened to whole months. */
  snapped_to_months: boolean;
  kpis: OemMetrics;
  by_oem: OemGroup[];
  by_product: OemGroup[];
  by_oem_product: OemProductRow[];
  by_month: (OemMetrics & { year: number; month: number; quarter: number })[];
  by_quarter: (OemMetrics & { fy_year: number; quarter: number; label: string })[];
  prior_year: { oem: string; py_nos: number | null; py_value: number | null }[];
  value_scales: Record<string, { target: string | null; actual: string | null }>;
}
interface PeriodMonth { year: number; month: number; fy_year: number; has_actual: boolean }
interface PeriodsResponse {
  months: PeriodMonth[];
  latest_actual: { year: number; month: number } | null;
  fy_years: number[];
}

/** Units or money out of the same row. Nothing is coerced to 0 — `ach` stays
 *  null for a month nobody has published, and the chart draws no bar. */
function pick(r: OemMetrics, m: Metric) {
  return m === "value"
    ? {
        tgt: r.tgt_value ?? 0, ach: r.ach_value, tgtToDate: r.tgt_value_todate,
        pace: r.pace_pct_value, year: r.year_pct_value, gap: r.gap_value,
      }
    : {
        tgt: r.tgt_nos ?? 0, ach: r.ach_nos, tgtToDate: r.tgt_nos_todate,
        pace: r.pace_pct_nos, year: r.year_pct_nos, gap: r.gap_nos,
      };
}

const fmtNos = (n: number) => Math.round(n).toLocaleString("en-IN");
const fmtBy = (m: Metric) => (m === "value" ? formatCompact : fmtNos);
const signed = (n: number, fmt: (v: number) => string) =>
  `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;

/**
 * A bullet row measures achievement against the target of the months that have
 * actually been published, NOT the whole period's target — otherwise every OEM
 * is short until March and the chart says nothing about performance.
 *
 * When nothing in the row has been published there is no such target, so the
 * track falls back to the full period target and the bar is absent rather than
 * zero-length: "not yet" and "sold none" must not look the same.
 */
function toBullet(rows: OemGroup[], metric: Metric, label: (k: string) => string): BulletDatum[] {
  return rows.map((r) => {
    const v = pick(r, metric);
    return {
      key: label(r.key),
      sub: r.months_published < r.months_total
        ? `${r.months_published} of ${r.months_total} month${r.months_total === 1 ? "" : "s"} in`
        : null,
      tgt: v.tgtToDate || v.tgt,
      ach: v.ach,
      pct: v.pace,
    };
  });
}

export default function OemTargetsTab({ headers }: { headers: Record<string, string> }) {
  const period = usePeriod("monthly");
  const [periods, setPeriods] = useState<PeriodsResponse | null>(null);
  const [options, setOptions] = useState<
    { oems: string[]; products: string[]; product_keys: string[] } | null>(null);
  const [metric, setMetric] = useState<Metric>("value");
  const [oem, setOem] = useState("");
  const [productKey, setProductKey] = useState("");
  const [data, setData] = useState<OemSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { syncing, syncAll } = useSyncLatest(headers, () => setRefreshKey((n) => n + 1), ["oem_targets"]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/oem-targets/periods`, { headers }),
        fetch(`${API_URL}/oe-network/oem-targets/filter-options`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        const p: PeriodsResponse = await perRes.json();
        setPeriods(p);
        // Recomputed every time, not latched, so registering the sheet and
        // hitting Refresh clears this without a remount.
        setEmpty(p.months.length === 0);
        // The picker offers EVERY month the sheet covers, future ones
        // included: a full year of targets is published up front and reading
        // March's target in August is a legitimate thing to want.
        period.setMonths(p.months.map((m) => ({ year: m.year, month: m.month })));
        if (!p.months.length) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Land on the newest month whose ACHIEVEMENT is in, not simply the newest
  // month that exists. Every month of the year has a target, so "newest month
  // with data" would open on next March — a screen of targets with no results
  // against them, which reads as broken.
  useEffect(() => {
    if (period.token || !period.options.length || !periods) return;
    const latest = periods.latest_actual;
    const wanted = latest && `${latest.year}-${latest.month}`;
    period.setToken(
      (wanted && period.options.some((o) => o.value === wanted) ? wanted : period.options[0].value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.options, periods]);

  useEffect(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    // Half a custom range is not a question we can ask. Drop what's on screen
    // rather than leaving the previous period's numbers under a period the
    // user is still typing — they read as that period's answer.
    if (!pp) { setData(null); setLoading(false); return; }
    const params = new URLSearchParams(pp);
    if (oem) params.set("oem", oem);
    if (productKey) params.set("product_key", productKey);
    // Abort on supersede, like every other tab: without it a slow earlier
    // response lands after a newer one and shows the wrong filter's data.
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/oem-targets/summary?${params}`,
          { headers, signal: ctrl.signal });
        setData(res.ok ? await res.json() : null);
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.mode, period.token, period.range, oem, productKey, refreshKey]);

  const activeFilters = [oem && `OEM ${oem}`, productKey && categoryLabel(productKey)]
    .filter(Boolean) as string[];
  const hasFilters = activeFilters.length > 0;
  const clearFilters = () => { setOem(""); setProductKey(""); };
  const rangeIncomplete = period.mode === "custom" && !(period.range.from && period.range.to);

  const fmt = fmtBy(metric);
  const k = data?.kpis;
  const kv = k ? pick(k, metric) : null;
  const partial = !!k && k.months_published < k.months_total;

  // Does this selection include the newest month that has any result at all?
  //
  // It matters because that month is usually STILL BEING FILLED IN — the sheet
  // is updated through the month and carries no "as of" date, so a month that
  // is three weeks old and a month that is three days old look identical. The
  // tab opens on it by default, and on the 26th of the month it reads 42%
  // against a five-month pace of 84%. That is not a collapse, it is an
  // incomplete month, and nothing in the data says so. This is the only honest
  // thing we can say about it, so it gets said rather than left to be misread.
  const latest = periods?.latest_actual;
  const onLatestMonth = !!latest && (data?.by_month ?? []).some(
    (m) => m.year === latest.year && m.month === latest.month && m.months_published > 0);
  // Last year's actual is a FULL prior year with no months in it, so it is only
  // comparable against a full year of target. Anything narrower would put a
  // 12-month figure beside a 1-month one.
  const fullYearView = period.mode === "yearly" || period.mode === "all";

  // A crore-scaled column can only express ₹0.01 Cr, i.e. ₹1 lakh — worth
  // saying out loud when someone reconciles against the sheet to the rupee.
  // includes(), not ===: a scale is detected per column, so one OEM can report
  // "crores/rupees" — and a grouped OEM merges two tabs that may disagree.
  const croreOems = Object.entries(data?.value_scales ?? {})
    .filter(([, s]) => !!s.target?.includes("crores") || !!s.actual?.includes("crores"))
    .map(([o]) => o);

  if (empty) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
        No OEM target data yet — register the financial year&rsquo;s{" "}
        <b>OEM Target Summary</b> sheet from the <b>Data Source Sheets</b> tab.
      </div>
    );
  }

  const monthChart = (data?.by_month ?? []).map((m) => {
    const v = pick(m, metric);
    return {
      name: `${MONTH_SHORT[m.month - 1]} ${String(m.year).slice(2)}`,
      Target: v.tgt,
      // undefined, not 0 — recharts draws nothing at all for it, which is the
      // correct picture of a month whose result has not been published.
      Achieved: v.ach ?? undefined,
    };
  });
  const unpublishedMonths = (data?.by_month ?? []).filter((m) => m.months_published === 0);

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
          {(["value", "nos"] as Metric[]).map((m) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
                metric === m ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {m === "value" ? "Value" : "Units"}
            </button>
          ))}
        </div>
        {/* No person filter — this sheet names nobody. Entity, then type. */}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        {/* Product carries its own labels, so it can't use filterOpts. */}
        <Select value={productKey} onChange={setProductKey}
          options={[{ value: "", label: FILTER_LABELS.product.all },
                    ...(options?.product_keys ?? []).map((c) => ({ value: c, label: categoryLabel(c) }))]}
          placeholder={FILTER_LABELS.product.placeholder} />
        <ClearFilters show={hasFilters} onClear={clearFilters} />
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefreshKey((n) => n + 1)} disabled={loading} />
          <SyncButton onClick={syncAll} syncing={syncing}
            title="Re-pull this year's OEM Target Summary from Google Sheets" />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          OEM Target vs Achievement · {data?.label ?? ""} · {metric === "value" ? "Value" : "Units"}
          {oem && ` · ${oem}`}{productKey && ` · ${categoryLabel(productKey)}`}
        </p>
      </div>

      {!data && !loading ? (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
          {rangeIncomplete ? (
            "Pick a start and an end date to read OEM targets across a custom period."
          ) : (
            <>
              <p className="text-sm font-semibold text-gray-500 mb-1.5">
                {period.mode === "custom"
                  ? `No OEM targets for ${shortDate(period.range.from)} – ${shortDate(period.range.to)}`
                  : "No OEM targets match this selection"}
              </p>
              {/* Two different causes, and the wrong guess sends someone editing
                  dates when a filter is what emptied the screen. Name both. */}
              <p>
                The registered sheet covers{" "}
                <b className="text-gray-600">
                  {periods?.months.length
                    ? `${MONTH_SHORT[periods.months[periods.months.length - 1].month - 1]} `
                      + `${periods.months[periods.months.length - 1].year} – `
                      + `${MONTH_SHORT[periods.months[0].month - 1]} ${periods.months[0].year}`
                    : "—"}
                </b>.
              </p>
              {hasFilters && (
                <p className="mt-1.5">
                  The <b className="text-gray-600">{activeFilters.join(" + ")}</b>{" "}
                  filter{activeFilters.length > 1 ? "s" : ""} may be excluding everything —{" "}
                  <button onClick={clearFilters}
                    className="font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                    clear {activeFilters.length > 1 ? "them" : "it"}
                  </button>{" "}
                  to check.
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={metric === "value" ? "Target Value" : "Target Units"}
              value={kv ? fmt(kv.tgt) : "—"}
              sub={`${data?.label ?? ""}, whole period`}
              icon={<Target size={18} />} {...KPI.target} />
            <StatCard label={metric === "value" ? "Achieved Value" : "Achieved Units"}
              value={kv?.ach != null ? fmt(kv.ach) : "—"}
              sub={k ? `${k.months_published} of ${k.months_total} month${k.months_total === 1 ? "" : "s"} published` : undefined}
              icon={<TrendingUp size={18} />} {...KPI.ours} />
            <StatCard label="Pace" value={kv?.pace != null ? `${kv.pace}%` : "—"}
              sub={kv?.tgtToDate ? `of ${fmt(kv.tgtToDate)} due so far` : "nothing published yet"}
              icon={<Percent size={18} />}
              {...((kv?.pace ?? 0) >= ON_TRACK_PCT ? KPI.conversion : KPI.warning)} />
            <StatCard label="Gap vs Months Due"
              value={kv?.gap != null ? signed(kv.gap, fmt) : "—"}
              sub={kv?.gap == null ? "nothing published yet"
                   : kv.gap >= 0 ? "ahead of target" : "short of target"}
              icon={<Building2 size={18} />}
              {...(kv?.gap != null && kv.gap >= 0 ? KPI.conversion : KPI.danger)} />
          </div>

          <Explain>
            <b className="text-gray-700">Pace</b> divides what we achieved by the target
            of the months that have actually been published
            {kv?.tgtToDate ? <> — {fmt(kv.tgtToDate)} of {fmt(kv.tgt)} for {data?.label}</> : null}.
            It is the performance figure: <b className="text-gray-700">100% means on plan</b>, and
            it does not drift just because the year is young.{" "}
            <b className="text-gray-700">Progress</b> below divides by the whole period&rsquo;s
            target instead, so it climbs towards 100% as the year runs — a brand exactly on plan
            in month five reads about 42% there and 100% here. The sheet publishes a target for
            every month of the year up front and fills in the result month by month, which is why
            the two differ; neither is wrong, and reading Progress as performance is the mistake
            this note exists to prevent.
            {onLatestMonth && (
              <>
                {" "}
                <b className="text-gray-700">
                  {MONTH_SHORT[latest!.month - 1]} {latest!.year} is the newest month with any
                  result and may still be filling in
                </b>{" "}
                — the source is updated through the month and records no cut-off date, so a
                part-month sits here looking like a shortfall. Read its Pace as a floor that
                will rise, not as a final figure.
              </>
            )}
          </Explain>

          {partial && k && kv && (
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm print-avoid-break">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                  Progress through {data?.label}
                </h3>
                <p className="text-[11px] text-gray-500">
                  {k.months_published} of {k.months_total} months published
                  {data?.snapped_to_months && " · a day range is read as whole months, because a target is a number for a month"}
                </p>
              </div>
              <div className="relative h-3 rounded-full bg-gray-100 mt-3 overflow-hidden">
                <div className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${Math.min(kv.year ?? 0, 100)}%`, background: VISIT_COLOR }} />
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                <b className="text-gray-700">{kv.year != null ? `${kv.year}%` : "—"}</b> of the
                period&rsquo;s {fmt(kv.tgt)} target is banked
                {kv.ach != null && <> ({fmt(kv.ach)})</>}. This is elapsed progress, not
                performance — see Pace above.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By OEM</h3>
              <p className="text-[10px] text-gray-500 mb-1">
                Measured against the target for the months published, not the whole period —
                all of a brand&rsquo;s products together
              </p>
              <BulletChart rows={toBullet(data?.by_oem ?? [], metric, (s) => s)} fmt={fmt}
                empty="No OEM has a target in this window" />
            </div>

            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Product</h3>
              <p className="text-[10px] text-gray-500 mb-1">
                Product lines clubbed across every brand — the OEMs name them differently
                (&ldquo;Docket + Accessories&rdquo;, &ldquo;ACCESSORIES&rdquo;) and these are the same thing
              </p>
              <BulletChart rows={toBullet(data?.by_product ?? [], metric, categoryLabel)} fmt={fmt}
                empty="No product has a target in this window" />
            </div>
          </div>

          <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Month by Month</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthChart} margin={{ top: 18, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false} interval={0} />
                <YAxis tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => (metric === "value" ? formatCompactNos(v) : fmtNos(v))} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }}
                  itemStyle={{ color: CHART_LABEL }}
                  formatter={(v: number) => (v == null ? "—" : fmt(v))} />
                <Legend wrapperStyle={{ fontSize: 11 }}
                  formatter={(value: string) => <span style={{ color: CHART_LABEL }}>{value}</span>} />
                <Bar dataKey="Target" fill={NEUTRAL_BAR} radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="Target" position="top" fill="#9ca3af" fontSize={9} fontWeight={700}
                    formatter={(v: number) => (v == null ? "" : fmt(v))} />
                </Bar>
                <Bar dataKey="Achieved" fill={VISIT_COLOR} radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="Achieved" position="top" fill="#6b7280" fontSize={9} fontWeight={700}
                    formatter={(v: number) => (v == null ? "" : fmt(v))} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {unpublishedMonths.length > 0 && (
              <p className="text-[10px] text-gray-500 mt-2">
                {unpublishedMonths
                  .map((m) => `${MONTH_SHORT[m.month - 1]} ${String(m.year).slice(2)}`)
                  .join(", ")}{" "}
                {unpublishedMonths.length === 1 ? "carries a target with no result yet" : "carry a target with no result yet"} —
                those months show the grey target bar and nothing beside it. An absent result is
                not a zero, and the sheet&rsquo;s own quarter columns that print 0 for them are
                not used here.
              </p>
            )}
          </div>

          <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">OEM × Product</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right">Target</th>
                    <th className="py-2 pr-3 text-right">Due so far</th>
                    <th className="py-2 pr-3 text-right">Achieved</th>
                    <th className="py-2 pr-3 text-right">Gap</th>
                    <th className="py-2 text-right">Pace</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.by_oem_product ?? []).map((r, i) => {
                    const v = pick(r, metric);
                    return (
                      <tr key={i} className="border-b border-gray-50 hover:bg-orange-50/40">
                        <td className="py-2 pr-3 font-semibold text-gray-700">{r.oem}</td>
                        <td className="py-2 pr-3 text-gray-500">{r.key}</td>
                        <td className="py-2 pr-3 text-right text-gray-600">{fmt(v.tgt)}</td>
                        <td className="py-2 pr-3 text-right text-gray-600">
                          {v.tgtToDate != null ? fmt(v.tgtToDate) : "—"}
                        </td>
                        <td className="py-2 pr-3 text-right font-semibold"
                          style={{ color: v.ach == null ? "#9ca3af" : VISIT_COLOR }}>
                          {v.ach != null ? fmt(v.ach) : "—"}
                        </td>
                        <td className={`py-2 pr-3 text-right font-semibold ${
                          v.gap == null ? "text-gray-400" : v.gap >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {v.gap != null ? signed(v.gap, fmt) : "—"}
                        </td>
                        <td className={`py-2 text-right font-bold ${achColor(v.pace)}`}>
                          {v.pace != null ? `${v.pace}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-gray-500 mt-3">
              <b className="text-gray-600">Due so far</b> is the target of the months whose result
              has been published, and it is what <b className="text-gray-600">Gap</b> and{" "}
              <b className="text-gray-600">Pace</b> are measured against. The full-period{" "}
              <b className="text-gray-600">Target</b> sits beside it so both readings are on the
              same row. Products are listed as each OEM&rsquo;s own tab spells them — MAHINDRA
              sets separate targets for commercial and passenger seat covers, and merging them
              would report a number nobody agreed to.
            </p>
            {croreOems.length > 0 && metric === "value" && (
              <p className="text-[10px] text-gray-500 mt-2">
                {croreOems.join(", ")} are entered in the source sheet in crores to a few decimals,
                so their money figures carry a rounding of roughly ±₹1 lakh per cell. Unit counts
                are exact.
              </p>
            )}
          </div>

          {/* This year's ask against last year's result. Drawn only for a
              full-year view: the sheet's "25~26" columns are one figure for a
              whole year with no months in them, and putting that beside a
              single month's target would compare 12 months with one. */}
          {fullYearView && (data?.prior_year ?? []).length > 0 && (
            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                This Year&rsquo;s Target vs Last Year&rsquo;s Actual
              </h3>
              <p className="text-[10px] text-gray-500 mb-1">
                How much more each brand has been asked for. Last year is a full-year actual from
                the sheet&rsquo;s own &ldquo;25~26&rdquo; columns — it is never cut by the period.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-3">OEM</th>
                      <th className="py-2 pr-3 text-right">Last year actual</th>
                      <th className="py-2 pr-3 text-right">This year target</th>
                      <th className="py-2 text-right">Ask</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.prior_year ?? []).map((p) => {
                      const row = (data?.by_oem ?? []).find((o) => o.key === p.oem);
                      const tgt = row ? pick(row, metric).tgt : null;
                      const py = metric === "value" ? p.py_value : p.py_nos;
                      const growth = py && tgt != null ? ((tgt - py) / py) * 100 : null;
                      return (
                        <tr key={p.oem} className="border-b border-gray-50 hover:bg-orange-50/40">
                          <td className="py-2 pr-3 font-semibold text-gray-700">{p.oem}</td>
                          <td className="py-2 pr-3 text-right text-gray-600">
                            {py != null ? fmt(py) : "—"}
                          </td>
                          <td className="py-2 pr-3 text-right text-gray-600">
                            {tgt != null ? fmt(tgt) : "—"}
                          </td>
                          <td className={`py-2 text-right font-bold ${
                            growth == null ? "text-gray-400" : growth >= 0 ? "text-gray-700" : "text-gray-500"}`}>
                            {growth != null ? `${growth >= 0 ? "+" : "−"}${Math.abs(growth).toFixed(0)}%` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!fullYearView && (data?.prior_year ?? []).length > 0 && (
            <p className="text-[11px] text-gray-500 px-1">
              The sheet also carries last year&rsquo;s full-year actual per brand. Switch the
              period to <b className="text-gray-600">yearly</b> or <b className="text-gray-600">all time</b>{" "}
              to compare it against this year&rsquo;s target — against a single month it would put
              twelve months beside one.
            </p>
          )}
        </>
      )}
    </div>
  );
}
