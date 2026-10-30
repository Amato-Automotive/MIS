// UNIT ECONOMICS tab — what one unit of each product sells for, what it costs,
// and what is left. From the sheet's Unit Economics block ("Metrics of <product>"
// below Cash Flow). A month shows the sheet's own figures; a quarter or year is
// worked out from its totals (see unitEconomics.ts) — never by adding up prices.
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from "recharts";
import { useAuth } from "@/context/AuthContext";
import {
  Card, DashboardControls, EmptyState, SectionHeading, bucketLabelsOf,
  type FinAnalytics, type FinSubSection,
} from "./dashboardKit";
import { buildColorMap, type TrendView } from "./aggregate";
import { formatINR, formatKpi, GRID_LINE_COLOR, AXIS_TEXT_COLOR, SUCCESS_COLOR, DANGER_COLOR, SOURCES_COLOR } from "./format";
import ChartLegend from "./shared/ChartLegend";
import { productEconomics, productName, seriesOf, type ProductEconomics } from "./unitEconomics";
import { BarRow, TableCard, Th, TipBox, rowBg } from "./all-companies/shared";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// The cost build-up is drawn in neutral stone shades so the only colours that
// carry meaning in a card are profit (green) and loss (red). Products get the
// categorical palette in the trend chart — two different jobs, two colour sets.
const COST_SHADES = { product: "#726E68", variable: "#A8A196", fixed: "#D3CCBF" };

// Produced vs sold is volume, not money, so it stays in neutral ink: the
// lighter bar is what was made, the darker what was sold.
const PRODUCED_SHADE = "#C9C1B3";
const SOLD_SHADE = "#14161A";

/**
 * Units made against units sold. Making far more than selling means finished
 * stock is piling up — cash tied in inventory — which the per-unit figures
 * alone never show (AMATO SRN, Sep 2026: ~2.1 lakh seat covers made, ~18,000 sold).
 */
function ProducedVsSold({ rows, bucket }: { rows: { key: string; name: string; e: ProductEconomics }[]; bucket: string }) {
  const shown = rows.filter((r) => r.e.produced != null || r.e.sold != null);
  if (shown.length === 0) return null;
  return (
    <Card title="Produced vs sold"
      note={`Units made against units sold in ${bucket}, per product. Each row is on its own scale — the ratio is the point.`}>
      <div className="flex flex-col gap-3 mt-1">
        {shown.map(({ key, name, e }) => {
          const made = e.produced ?? 0;
          const sold = e.sold ?? 0;
          const scale = Math.max(made, sold) || 1;
          const ratio = e.produced != null && e.sold != null && e.sold > 0 ? e.produced / e.sold : null;
          const gap = e.produced != null && e.sold != null ? e.produced - e.sold : null;
          const verdict = ratio == null ? null
            : ratio >= 1.2 ? { text: `${ratio.toFixed(1)}× sales — stock building`, color: DANGER_COLOR }
            : ratio <= 0.8 ? { text: `${ratio.toFixed(1)}× sales — selling from stock`, color: "#B08400" }
            : { text: `${ratio.toFixed(2)}× sales — in step`, color: SUCCESS_COLOR };
          return (
            <BarRow key={key} name={name}
              value={verdict ? <span style={{ color: verdict.color }}>{verdict.text}</span> : "—"}
              hover={
                <TipBox title={name}>
                  <div className="flex justify-between gap-4"><span className="text-gray-600">Produced</span><span className="tabular-nums">{qty(e.produced)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-600">Sold</span><span className="tabular-nums">{qty(e.sold)}</span></div>
                  {gap != null && (
                    <div className="flex justify-between gap-4 font-semibold"><span>{gap >= 0 ? "Made beyond sales" : "Sold beyond making"}</span><span className="tabular-nums">{qty(Math.abs(gap))}</span></div>
                  )}
                </TipBox>
              }>
              <div className="flex flex-col gap-1">
                <div className="h-2 rounded-full bg-[#F3EEE4]"><div className="h-2 rounded-full" style={{ width: `${(made / scale) * 100}%`, background: PRODUCED_SHADE }} /></div>
                <div className="h-2 rounded-full bg-[#F3EEE4]"><div className="h-2 rounded-full" style={{ width: `${(sold / scale) * 100}%`, background: SOLD_SHADE }} /></div>
              </div>
            </BarRow>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: PRODUCED_SHADE }} />Units produced</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: SOLD_SHADE }} />Units sold</span>
        <span>
          Produced ÷ sold: 1.2× or more is <b style={{ color: DANGER_COLOR }}>stock building</b> (cash tied up in finished goods),
          0.8× or less is <b style={{ color: "#B08400" }}>selling from stock</b>, in between is <b style={{ color: SUCCESS_COLOR }}>in step</b>.
          A pointer, not a stock count — the sheet gives no opening or closing stock per product.
        </span>
      </div>
    </Card>
  );
}

const rupee = (n: number | null) => (n == null ? "—" : `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`);
const qty = (n: number | null) => (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
const pct = (f: number | null) => (f == null ? "—" : `${(f * 100).toFixed(1)}%`);

/**
 * One unit's price, split into what it costs and what is left. The bar's full
 * width is the larger of price and cost: a loss-making product's cost runs
 * past the price tick and the overrun is the loss.
 */
function PriceStack({ e }: { e: ProductEconomics }) {
  const { price, productCost, variableCost, fixedCost, costPerUnit, profitPerUnit } = e;
  if (price == null || costPerUnit == null || productCost == null) {
    return <div className="text-[11px] text-gray-500">Not enough figures this period to split the price.</div>;
  }
  const span = Math.max(price, costPerUnit) || 1;
  const w = (v: number | null) => `${(Math.max(0, v ?? 0) / span) * 100}%`;
  const loss = profitPerUnit != null && profitPerUnit < 0;
  return (
    <div>
      <div className="relative h-4 rounded-md overflow-hidden flex bg-[#F3EEE4]">
        <div style={{ width: w(productCost), background: COST_SHADES.product }} title={`Product cost ${rupee(productCost)}`} />
        <div style={{ width: w(variableCost), background: COST_SHADES.variable }} title={`Variable cost ${rupee(variableCost)}`} />
        <div style={{ width: w(fixedCost), background: COST_SHADES.fixed }} title={`Fixed cost ${rupee(fixedCost)}`} />
        {!loss && <div style={{ width: w(profitPerUnit), background: SUCCESS_COLOR }} title={`Profit ${rupee(profitPerUnit)}`} />}
      </div>
      {loss && (
        <div className="relative h-0">
          <div className="absolute -top-4 h-4 border-l-2 border-gray-800" style={{ left: `${(price / span) * 100}%` }} />
          <div className="absolute -top-4 h-4 opacity-40" style={{ left: `${(price / span) * 100}%`, width: `${((costPerUnit - price) / span) * 100}%`, background: DANGER_COLOR }} />
        </div>
      )}
    </div>
  );
}

function ProductCard({ name, e }: { name: string; e: ProductEconomics }) {
  const loss = e.profitPerUnit != null && e.profitPerUnit < 0;
  const accent = e.profitPerUnit == null ? "#8F8A83" : loss ? DANGER_COLOR : SUCCESS_COLOR;
  return (
    <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-5 overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: accent }} />
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] font-bold text-gray-800">{name}</div>
        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ color: accent, background: `${accent}14` }}>
          {e.margin == null ? "margin —" : `${pct(e.margin)} margin`}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight" style={{ color: e.profitPerUnit == null ? "#9CA3AF" : accent }}>{rupee(e.profitPerUnit)}</span>
        <span className="text-[11px] text-gray-500">{loss ? "loss" : "profit"} per unit</span>
      </div>
      <div className="mt-3"><PriceStack e={e} /></div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-gray-500" title="Revenue ÷ units sold">Avg selling price</dt><dd className="text-right font-semibold text-gray-800 tabular-nums">{rupee(e.price)}</dd>
        <dt className="text-gray-500" title="Product cost + variable + fixed operating cost, per unit">Avg cost per unit</dt><dd className="text-right font-semibold text-gray-800 tabular-nums">{rupee(e.costPerUnit)}</dd>
        <dt className="text-gray-500">Units sold</dt><dd className="text-right font-semibold text-gray-800 tabular-nums">{qty(e.sold)}</dd>
        <dt className="text-gray-500">Revenue</dt>
        <dd className="text-right font-semibold text-gray-800 tabular-nums" title={e.revenue != null ? formatINR(e.revenue) : undefined}>{e.revenue != null ? formatKpi(e.revenue) : "—"}</dd>
      </dl>
    </div>
  );
}

export default function UnitEconomicsView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
  const { token } = useAuth();
  const [data, setData] = useState<FinAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState<string>("");

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=unit_economics`, {
      headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load unit economics");
        return r.json();
      })
      .then((d: FinAnalytics) => setData(d))
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [sheetSourceId, token, refreshNonce]);

  const products: FinSubSection[] = useMemo(
    () => data?.groups.find((g) => g.section_key === "unit_economics")?.sub_sections.filter((s) => s.key) ?? [],
    [data]
  );
  const points = useMemo(() => products.flatMap((p) => p.line_items.flatMap((it) => it.series)), [products]);
  const bucketLabels = useMemo(() => bucketLabelsOf(points, "flow", view), [points, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  const rows = useMemo(
    () => products.map((p) => ({ key: p.key!, name: productName(p.key), e: productEconomics(p, view, effBucket) })),
    [products, view, effBucket]
  );
  const colors = useMemo(() => buildColorMap(products.map((p) => p.key!)), [products]);

  // Margin by product over the periods — the one trend: is each product getting
  // more or less profitable per unit?
  const trend = useMemo(() => bucketLabels.map((label) => {
    const row: Record<string, number | string | null> = { label };
    for (const p of products) row[p.key!] = productEconomics(p, view, label).margin;
    return row;
  }), [bucketLabels, products, view]);

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading unit economics…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (products.length === 0 || points.every((p) => p.amount == null)) {
    return (
      <EmptyState>
        <div className="font-semibold text-gray-600 mb-1">No unit economics for this company yet</div>
        Finance adds a <b>Unit Economics</b> block below Cash Flow in the company's tab, one "Metrics of …" group per
        product. Once it's in the sheet and synced, each product shows here.
      </EmptyState>
    );
  }

  const derived = view !== "monthly";
  const legend = products.map((p) => ({ key: p.key!, label: productName(p.key), color: colors.get(p.key!)! }));

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />

      <SectionHeading accent={SOURCES_COLOR}>Per unit · {effBucket || "—"}</SectionHeading>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {rows.map((r) => <ProductCard key={r.key} name={r.name} e={r.e} />)}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 -mt-3 text-[11px] text-gray-500">
        <span>Prices and costs are averages per unit sold, not totals. Each bar is one unit's average selling price:</span>
        {([["product", "Product cost"], ["variable", "Variable operating cost"], ["fixed", "Fixed operating cost"]] as const).map(([k, l]) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: COST_SHADES[k] }} />{l}</span>
        ))}
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: SUCCESS_COLOR }} />Profit</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm opacity-40" style={{ background: DANGER_COLOR }} />Cost beyond the price (loss)</span>
      </div>

      <TableCard footer={
        derived ? (
          <>The sheet gives these per unit month by month; for {effBucket} they are worked out from the period's totals —
            selling price = revenue ÷ units sold, product cost = total cost of products ÷ units produced, operating costs per unit
            weighted by units sold, profit = price − cost per unit, margin = profit ÷ price.</>
        ) : (
          <>The sheet's own figures for {effBucket}. Cost per unit = product cost + variable + fixed operating cost; profit per
            unit = selling price − cost per unit; margin = profit ÷ price. "—" = the sheet has no figure (e.g. a #DIV/0! when
            nothing was produced).</>
        )
      }>
        <thead>
          <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
            <Th align="left">Product</Th>
            <Th>Units sold</Th>
            <Th>Units produced</Th>
            <Th>Revenue</Th>
            <Th>Avg selling price</Th>
            <Th>Product cost</Th>
            <Th>Operating cost</Th>
            <Th>Avg cost / unit</Th>
            <Th>Profit / unit</Th>
            <Th>Margin</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, e }, i) => {
            const opCost = e.variableCost != null && e.fixedCost != null ? e.variableCost + e.fixedCost : null;
            const tone = e.profitPerUnit == null ? undefined : e.profitPerUnit < 0 ? DANGER_COLOR : SUCCESS_COLOR;
            return (
              <tr key={key} className={rowBg(i)}>
                <td className="px-4 py-3 text-[13px] font-semibold text-gray-800 whitespace-nowrap">
                  <span className="inline-block w-2 h-2 rounded-sm mr-2 align-middle" style={{ background: colors.get(key) }} />{name}
                </td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-800">{qty(e.sold)}</td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-800">{qty(e.produced)}</td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-800" title={e.revenue != null ? formatINR(e.revenue) : undefined}>
                  {e.revenue != null ? formatKpi(e.revenue) : "—"}
                </td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-800">{rupee(e.price)}</td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-800">{rupee(e.productCost)}</td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-800" title={opCost != null ? `Variable ${rupee(e.variableCost)} + fixed ${rupee(e.fixedCost)}` : undefined}>{rupee(opCost)}</td>
                <td className="px-4 py-3 text-right text-[13px] font-semibold tabular-nums text-gray-800">{rupee(e.costPerUnit)}</td>
                <td className="px-4 py-3 text-right text-[13px] font-bold tabular-nums" style={{ color: tone }}>{rupee(e.profitPerUnit)}</td>
                <td className="px-4 py-3 text-right text-[13px] font-bold tabular-nums" style={{ color: tone }}>{pct(e.margin)}</td>
              </tr>
            );
          })}
        </tbody>
      </TableCard>

      <ProducedVsSold rows={rows} bucket={effBucket} />

      {trend.length > 1 && (
        <Card title="Margin per unit over time"
          note={`Profit ÷ selling price for each product, by ${view === "monthly" ? "month" : view === "quarterly" ? "quarter" : "year"}. Below the zero line, each unit sold loses money.`}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trend} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
              <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={48} />
              <ReferenceLine y={0} stroke="#4B5563" />
              <Tooltip
                content={(p: any) => {
                  if (!p?.active || !p.payload?.length) return null;
                  return (
                    <TipBox title={p.label}>
                      {legend.map((l) => {
                        const v = p.payload[0].payload[l.key] as number | null;
                        return (
                          <div key={l.key} className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 text-gray-600"><span className="w-2 h-2 rounded-sm" style={{ background: l.color }} />{l.label}</span>
                            <span className="tabular-nums" style={{ color: v == null ? undefined : v < 0 ? DANGER_COLOR : undefined }}>{pct(v)}</span>
                          </div>
                        );
                      })}
                    </TipBox>
                  );
                }} />
              {legend.map((l) => (
                <Line key={l.key} dataKey={l.key} name={l.label} stroke={l.color} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <ChartLegend items={legend} />
        </Card>
      )}

      {products.some((p) => seriesOf(p, "unit_sold").length === 0) && (
        <p className="text-[11px] text-gray-500 -mt-3">Some products have no units sold in the sheet, so their per-unit figures can't be worked out.</p>
      )}
    </div>
  );
}
