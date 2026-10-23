import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  KpiCard, MoneyTrendCard, GroupBlock, DashboardControls, EmptyState, ProfitBridgeCard, MarginTrendCard,
  RatiosPanel, WatchListCard, SectionHeading, bucketLabelsOf, bucketChange, bucketPercent,
  type FinAnalytics, type FinGroup, type FinPoint,
} from "./dashboardKit";
import type { TrendView } from "./aggregate";
import { MarginClassCard } from "./MarginClassCard";
import { formatINR, formatKpi, REVENUE_COLOR, GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, SUCCESS_COLOR } from "./format";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function findItemSeries(groups: FinGroup[], lineKey: string): FinPoint[] {
  for (const g of groups) {
    for (const sub of g.sub_sections) {
      const it = sub.line_items.find((x) => x.line_key === lineKey);
      if (it) return it.series;
      if (sub.total?.line_key === lineKey) return sub.total.series;
    }
  }
  return [];
}

export default function ProfitLossView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
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
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=profit_loss`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load P&L");
        return r.json();
      })
      .then((d: FinAnalytics) => {
        if (!alive) return;
        setData(d);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [sheetSourceId, token, refreshNonce]);

  const sales = useMemo(() => (data ? findItemSeries(data.groups, "profit_loss_a_c/sales_accounts") : []), [data]);
  const gross = useMemo(() => (data ? findItemSeries(data.groups, "profit_loss_a_c/gross_margin") : []), [data]);
  const pbitda = useMemo(() => (data ? findItemSeries(data.groups, "profit_loss_a_c/pbitda") : []), [data]);
  const pat = useMemo(() => (data ? findItemSeries(data.groups, "profit_loss_a_c/pat") : []), [data]);
  const plGroup = useMemo(() => data?.groups.find((g) => g.section_key === "profit_loss_a_c") ?? null, [data]);
  const bucketLabels = useMemo(() => bucketLabelsOf(sales, "flow", view), [sales, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading P&L…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (!data || data.periods.length === 0) return <EmptyState>No P&amp;L data yet. Click “Sync Now” to pull the latest from the sheet.</EmptyState>;

  // KPIs at the selected bucket/granularity so they track the control.
  const salesCh = bucketChange(sales, "flow", view, effBucket);
  const grossCh = bucketChange(gross, "flow", view, effBucket);
  const pbitdaCh = bucketChange(pbitda, "flow", view, effBucket);
  const patCh = bucketChange(pat, "flow", view, effBucket);
  // The sheet's own "% of Sales" for each line, as typed — never recomputed.
  const salesShare = bucketPercent(sales, view, effBucket);
  const grossShare = bucketPercent(gross, view, effBucket);
  const pbitdaShare = bucketPercent(pbitda, view, effBucket);
  const patShare = bucketPercent(pat, view, effBucket);
  const changePct = salesCh.value != null && salesCh.prevValue != null && salesCh.prevValue > 0
    ? Math.round(((salesCh.value - salesCh.prevValue) / salesCh.prevValue) * 1000) / 10 : null;
  const changeLabel = view === "monthly" ? "MoM Sales" : view === "quarterly" ? "QoQ Sales" : "YoY Sales";

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <KpiCard label={`Sales · ${effBucket}`} value={formatKpi(salesCh.value ?? 0)} exact={formatINR(salesCh.value ?? 0)} accent={REVENUE_COLOR} share={salesShare} shareOf="of Sales" />
        <KpiCard label={`Gross Margin · ${effBucket}`} value={formatKpi(grossCh.value ?? 0)} exact={formatINR(grossCh.value ?? 0)} accent={GROSS_PROFIT_COLOR} share={grossShare} shareOf="of Sales" />
        {/* SOURCES_COLOR (the bridge's PBITDA colour) is the same steel blue as
            Sales, so use the green profit tone to keep the cards distinguishable. */}
        <KpiCard label={`PBITDA · ${effBucket}`} value={formatKpi(pbitdaCh.value ?? 0)} exact={formatINR(pbitdaCh.value ?? 0)} accent={SUCCESS_COLOR} share={pbitdaShare} shareOf="of Sales" />
        <KpiCard label={`PAT · ${effBucket}`} value={formatKpi(patCh.value ?? 0)} exact={formatINR(patCh.value ?? 0)} accent={NETT_PROFIT_COLOR} share={patShare} shareOf="of Sales" />
        <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-4 overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: changePct == null ? "#8F8A83" : changePct >= 0 ? "#4E7D57" : "#B5483A" }} />
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{changeLabel} Change</div>
          <div className="text-2xl font-bold mt-1 tracking-tight" style={{ color: changePct == null ? "#8F8A83" : changePct >= 0 ? "#4E7D57" : "#B5483A" }}>
            {changePct != null ? `${changePct > 0 ? "+" : ""}${changePct}%` : "—"}
          </div>
          <div className="text-[11px] font-medium text-gray-500 mt-0.5">{salesCh.prevLabel ? `${salesCh.prevLabel} → ${effBucket}` : "No prior period"}</div>
        </div>
      </div>

      <MarginClassCard sales={salesCh.value} pat={patCh.value} bucket={effBucket} />

      <WatchListCard data={data} view={view} bucket={effBucket} />

      <div className="grid gap-4 xl:grid-cols-2">
        <MoneyTrendCard title="Revenue & Profit" note="Sales bars with PAT overlaid, summed per period across the merged timeline (flow)."
          primary={sales} primaryLabel="Sales" kind="flow"
          secondary={pat} secondaryLabel="PAT" view={view} />
        <MarginTrendCard salesSeries={sales} grossSeries={gross} patSeries={pat} view={view} />
      </div>

      {plGroup && <ProfitBridgeCard group={plGroup} view={view} bucket={effBucket} />}

      {data.ratios && data.ratios.length > 0 && (
        <>
          <SectionHeading>Financial Health</SectionHeading>
          <RatiosPanel ratios={data.ratios} view={view} bucket={effBucket} title="Profitability & Growth Ratios" />
        </>
      )}

      {data.groups.map((g) => (
        <GroupBlock key={g.section_key} group={g} view={view} bucket={effBucket} kind="flow" />
      ))}
    </div>
  );
}
