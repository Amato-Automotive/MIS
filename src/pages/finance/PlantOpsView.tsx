import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import {
  Card, KpiCard, DashboardControls, EmptyState, SectionHeading, UnitCostPanel,
  buildTimeline, bucketValue, bucketLabelsOf,
  type FinAnalytics, type FinGroup, type FinLineItem, type FinPoint,
} from "./dashboardKit";
import { SOURCES_COLOR, APPLICATION_COLOR, GRID_LINE_COLOR, AXIS_TEXT_COLOR } from "./format";
import type { TrendView } from "./aggregate";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const fmtQty = (n: number) => Math.round(n).toLocaleString("en-IN");

// Sum a set of line items into one total series (aligned by period).
function sumItems(items: FinLineItem[]): FinPoint[] {
  const byPeriod = new Map<string, FinPoint>();
  for (const it of items) {
    for (const p of it.series) {
      if (p.amount == null) continue;
      const cur = byPeriod.get(p.period_end_date);
      if (cur) cur.amount = (cur.amount ?? 0) + p.amount;
      else byPeriod.set(p.period_end_date, { ...p, amount: p.amount });
    }
  }
  return [...byPeriod.values()];
}

// §7 UNITS is laid out in the sheet as separate 4-wheeler and 2-wheeler blocks,
// each with its own Sales and Production side — genuinely different businesses,
// so they are reported as separate blocks rather than merged into one total.
// The bare sales/productions pair is the older single-block layout still used by
// the test master sheets; it renders as one unlabelled block.
const SEGMENT_DEFS = [
  { key: "4w", label: "4 Wheeler", salesKey: "sales_4w", prodKey: "productions_4w" },
  { key: "2w", label: "2 Wheeler", salesKey: "sales_2w", prodKey: "productions_2w" },
  { key: "all", label: "", salesKey: "sales", prodKey: "productions" },
];

// Items directly under a segment PLUS any nested group beneath it (the sheet
// nests an "Others" group holding Lifestyle and Bags inside the 2w blocks).
function itemsUnder(units: FinGroup | null, prefix: string): FinLineItem[] {
  if (!units) return [];
  return units.sub_sections
    .filter((s) => s.key === prefix || (s.key?.startsWith(`${prefix}/`) ?? false))
    .flatMap((s) => s.line_items);
}

function UnitsSegmentBlock({ label, salesItems, prodItems, view, bucket }: {
  label: string; salesItems: FinLineItem[]; prodItems: FinLineItem[];
  view: TrendView; bucket: string;
}) {
  const salesTotal = useMemo(() => sumItems(salesItems), [salesItems]);
  const prodTotal = useMemo(() => sumItems(prodItems), [prodItems]);

  const barData = useMemo(() => {
    const prodByLabel = new Map(prodItems.map((it) => [it.line_label, it]));
    // Union of both sides, so a product that is produced but not sold (or vice
    // versa) still appears rather than being silently dropped.
    const names = [...new Set([...salesItems.map((i) => i.line_label), ...prodItems.map((i) => i.line_label)])];
    const salesByLabel = new Map(salesItems.map((it) => [it.line_label, it]));
    return names.map((name) => ({
      name,
      Sales: bucketValue(salesByLabel.get(name)?.series ?? [], "flow", view, bucket) ?? 0,
      Production: bucketValue(prodByLabel.get(name)?.series ?? [], "flow", view, bucket) ?? 0,
    }));
  }, [salesItems, prodItems, view, bucket]);

  const trendData = useMemo(() => {
    const s = buildTimeline(salesTotal, "flow", view);
    const p = new Map(buildTimeline(prodTotal, "flow", view).map((x) => [x.label, x.value]));
    return s.map((x) => ({ label: x.label, Sales: x.value, Production: p.get(x.label) ?? 0 }));
  }, [salesTotal, prodTotal, view]);

  const cols = useMemo(() => bucketLabelsOf(salesTotal, "flow", view).slice(-8), [salesTotal, view]);
  const sold = bucketValue(salesTotal, "flow", view, bucket);
  const made = bucketValue(prodTotal, "flow", view, bucket);

  return (
    <>
      <SectionHeading>{label ? `Units — ${label}` : "Units — Sales vs Production"}</SectionHeading>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard label={`Units Sold · ${bucket}`} value={sold != null ? fmtQty(sold) : "—"} accent={SOURCES_COLOR} />
        <KpiCard label={`Units Produced · ${bucket}`} value={made != null ? fmtQty(made) : "—"} accent={APPLICATION_COLOR} />
        {/* "No production reported" must not read as "produced nothing" — a
            company that only reports sales for a month (AMATO NOIDA does) would
            otherwise show a confident 0%. */}
        <KpiCard label="Production vs Sales"
          value={sold && made != null ? `${Math.round((made / sold) * 100)}%` : "—"}
          deltaPeriod={made == null ? "no production reported" : sold != null && sold > 0 ? (made >= sold ? "producing to/above demand" : "under-producing vs demand") : null}
          deltaPct={made != null && sold != null && sold > 0 ? (made >= sold ? 0 : -1) : null} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Sales vs Production by Category" note={`Units per product category · ${bucket}`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
              <YAxis tickFormatter={fmtQty} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={54} />
              <Tooltip formatter={(v: any, n: any) => [fmtQty(Number(v)), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Sales" fill={SOURCES_COLOR} radius={[3, 3, 0, 0]} maxBarSize={40} />
              <Bar dataKey="Production" fill={APPLICATION_COLOR} radius={[3, 3, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Sales & Production Over Time" note="Total units at the current granularity.">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trendData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
              <YAxis tickFormatter={fmtQty} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={54} />
              <Tooltip formatter={(v: any, n: any) => [fmtQty(Number(v)), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="Sales" stroke={SOURCES_COLOR} strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="Production" stroke={APPLICATION_COLOR} strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Units — detail" note="Values at the current granularity; use the View control at the top to switch.">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="text-left py-2 pr-3 font-semibold text-gray-500 sticky left-0 bg-white">Category</th>
                {cols.map((c) => (
                  <th key={c} className="text-right py-2 px-3 font-semibold text-gray-500 whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {([["Sales", salesItems], ["Production", prodItems]] as const).map(([heading, items]) => (
                <Fragment key={heading}>
                  <tr className="border-b border-gray-100">
                    <td colSpan={cols.length + 1} className="py-1.5 pr-3 font-bold text-gray-800 sticky left-0 bg-white">{heading}</td>
                  </tr>
                  {items.map((it) => {
                    const m = new Map(buildTimeline(it.series, "flow", view).map((x) => [x.label, x.value]));
                    return (
                      <tr key={heading + it.line_key} className="border-b border-gray-100">
                        <td className="py-2 pr-3 pl-3 text-gray-600 sticky left-0 bg-white">{it.line_label}</td>
                        {cols.map((c) => {
                          const v = m.get(c);
                          return <td key={c} className="py-2 px-3 text-right text-gray-600 whitespace-nowrap">{v != null ? fmtQty(v) : "—"}</td>;
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

export default function PlantOpsView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
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
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=plant_ops`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load Plant Operations");
        return r.json();
      })
      .then((d: FinAnalytics) => { if (alive) setData(d); })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [sheetSourceId, token, refreshNonce]);

  const units: FinGroup | null = useMemo(() => data?.groups.find((g) => g.section_key === "units") ?? null, [data]);

  // Only the segments this company actually reports — the sheet's layout varies
  // (VSA/AFAC/YSA are 4-wheeler only), so blocks are discovered, not assumed.
  const segments = useMemo(() => SEGMENT_DEFS
    .map((def) => ({
      ...def,
      salesItems: itemsUnder(units, def.salesKey),
      prodItems: itemsUnder(units, def.prodKey),
    }))
    .filter((s) => s.salesItems.length > 0 || s.prodItems.length > 0),
    [units]);

  const unitCostGroup: FinGroup | null = useMemo(() => data?.groups.find((g) => g.section_key === "average_unit_cost") ?? null, [data]);
  const unitCostItems = useMemo(() => unitCostGroup?.sub_sections.flatMap((s) => s.line_items) ?? [], [unitCostGroup]);
  const hasUnitCost = unitCostItems.some((it) => it.series.some((p) => p.amount != null && p.amount > 0));

  // One universal period control for the whole tab — labels pooled across every
  // segment so a period any block has data for is selectable.
  const labelSource = useMemo(() => {
    const pooled = segments.flatMap((s) => [...s.salesItems, ...s.prodItems]).flatMap((it) => it.series);
    return pooled.length ? pooled : (unitCostItems[0]?.series ?? []);
  }, [segments, unitCostItems]);
  const bucketLabels = useMemo(() => bucketLabelsOf(labelSource, "flow", view), [labelSource, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  const hasUnits = segments.length > 0 && (data?.periods.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      {loading && <div className="text-sm text-gray-500 py-10 text-center">Loading Plant Operations…</div>}
      {error && <EmptyState>{error}</EmptyState>}

      {!loading && !error && (hasUnits || hasUnitCost) && (
        <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />
      )}

      {!loading && !error && hasUnits && segments.map((s) => (
        <UnitsSegmentBlock key={s.key} label={s.label} salesItems={s.salesItems} prodItems={s.prodItems}
          view={view} bucket={effBucket} />
      ))}

      {!loading && !error && hasUnitCost && unitCostGroup && (
        <>
          <SectionHeading accent={APPLICATION_COLOR}>Average Unit Cost</SectionHeading>
          <UnitCostPanel group={unitCostGroup} view={view} bucket={effBucket} />
        </>
      )}

      {!loading && !error && !hasUnits && !hasUnitCost && (
        <EmptyState>
          <div className="font-semibold text-gray-500 mb-1">No Plant Operations data yet</div>
          The Units and Unit Cost sections are empty for this company. Click “Sync Now” once the sheet has data.
        </EmptyState>
      )}
    </div>
  );
}
