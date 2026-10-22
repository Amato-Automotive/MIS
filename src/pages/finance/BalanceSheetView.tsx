import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  KpiCard, MoneyTrendCard, GroupBlock, DashboardControls, EmptyState, RatiosPanel,
  CashCycleCard, ReconciliationPanel, WatchListCard, SectionHeading, AgingPanel, bucketLabelsOf, bucketChange, bucketEndDate, bucketPercent, fmtAsAt,
  type FinAnalytics, type FinGroup, type FinPoint,
} from "./dashboardKit";
import type { TrendView } from "./aggregate";
import { formatINR, formatKpi, SOURCES_COLOR, APPLICATION_COLOR, SUCCESS_COLOR, DANGER_COLOR } from "./format";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function findTotalSeries(groups: FinGroup[], sectionKey: string, subKey: string): FinPoint[] {
  const g = groups.find((x) => x.section_key === sectionKey);
  const sub = g?.sub_sections.find((s) => s.key === subKey);
  return sub?.total?.series ?? [];
}

export default function BalanceSheetView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
  const { token } = useAuth();
  const [data, setData] = useState<FinAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("yearly");
  const [bucket, setBucket] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=balance_sheet`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load balance sheet");
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

  const sources = useMemo(() => (data ? findTotalSeries(data.groups, "balance_sheet", "sources_of_funds") : []), [data]);
  const application = useMemo(() => (data ? findTotalSeries(data.groups, "balance_sheet", "application_of_funds") : []), [data]);
  const bucketLabels = useMemo(() => bucketLabelsOf(sources, "stock", view), [sources, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading balance sheet…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (!data || data.periods.length === 0) return <EmptyState>No balance-sheet data yet. Click “Sync Now” to pull the latest from the sheet.</EmptyState>;

  // KPIs computed at the selected bucket/granularity so they track the control.
  const srcCh = bucketChange(sources, "stock", view, effBucket);
  const appCh = bucketChange(application, "stock", view, effBucket);
  const changePct = srcCh.value != null && srcCh.prevValue != null && srcCh.prevValue > 0
    ? Math.round(((srcCh.value - srcCh.prevValue) / srcCh.prevValue) * 1000) / 10 : null;
  const changeLabel = view === "monthly" ? "MoM Change" : view === "quarterly" ? "QoQ Change" : "YoY Change";
  const gap = srcCh.value != null && appCh.value != null ? srcCh.value - appCh.value : null;
  const balanced = gap != null && Math.abs(gap) < 1;
  // A balance sheet is a point-in-time snapshot: the quarter/year figure is the
  // balance AT period-end, not a sum. Label the KPIs with that as-at date so the
  // "same value across views" is self-explanatory rather than looking wrong.
  // The sheet's own composition % for each side, as typed — never recomputed.
  const srcShare = bucketPercent(sources, view, effBucket);
  const appShare = bucketPercent(application, view, effBucket);
  const asAt = fmtAsAt(bucketEndDate(sources, view, effBucket));
  const asAtTxt = asAt ? `as at ${asAt}` : effBucket;

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />

      <p className="text-[11px] text-gray-500 -mb-2">
        Balance-sheet figures are point-in-time snapshots — a quarter or year shows the balance <b>as at</b> its period-end date, not a sum of months.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label={`Sources of Funds · ${asAtTxt}`} value={srcCh.value != null ? formatKpi(srcCh.value) : "—"} exact={srcCh.value != null ? formatINR(srcCh.value) : undefined} accent={SOURCES_COLOR} share={srcShare} shareOf="of the balance sheet" />
        <KpiCard label={`Application of Funds · ${asAtTxt}`} value={appCh.value != null ? formatKpi(appCh.value) : "—"} exact={appCh.value != null ? formatINR(appCh.value) : undefined} accent={APPLICATION_COLOR} share={appShare} shareOf="of the balance sheet" />
        <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-4 overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: changePct == null ? "#8F8A83" : changePct >= 0 ? SUCCESS_COLOR : DANGER_COLOR }} />
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{changeLabel}</div>
          <div className="text-2xl font-bold mt-1 tracking-tight" style={{ color: changePct == null ? "#8F8A83" : changePct >= 0 ? SUCCESS_COLOR : DANGER_COLOR }}>
            {changePct != null ? `${changePct > 0 ? "+" : ""}${changePct}%` : "—"}
          </div>
          <div className="text-[11px] font-medium text-gray-500 mt-0.5">{srcCh.prevLabel ? `${srcCh.prevLabel} → ${effBucket}` : "No prior period"}</div>
        </div>
        <div className="relative bg-white border border-[#EAE3D6] rounded-2xl p-4 overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[3px]" style={{ background: balanced ? SUCCESS_COLOR : DANGER_COLOR }} />
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Balance Check</div>
          <div className="text-2xl font-bold mt-1 tracking-tight" style={{ color: balanced ? SUCCESS_COLOR : DANGER_COLOR }}>
            {balanced ? "Balanced" : gap != null ? formatKpi(Math.abs(gap)) : "—"}
          </div>
          <div className="text-[11px] font-medium text-gray-500 mt-0.5">
            {balanced ? "Sources = Application" : gap != null ? `Off by ${formatINR(Math.abs(gap))}` : "No data"}
          </div>
        </div>
      </div>

      <WatchListCard data={data} view={view} bucket={effBucket} />

      <MoneyTrendCard title="Balance Sheet Size" note="Total Sources of Funds over the merged yearly + monthly timeline (point-in-time)."
        primary={sources} primaryLabel="Sources of Funds" kind="stock"
        secondary={application} secondaryLabel="Application of Funds" view={view} />

      {data.ratios && data.ratios.length > 0 && (
        <>
          <SectionHeading>Financial Health</SectionHeading>
          <CashCycleCard ratios={data.ratios} view={view} bucket={effBucket} />
          <RatiosPanel ratios={data.ratios} view={view} bucket={effBucket} title="Balance Sheet Ratios" />
          {data.reconciliation && data.reconciliation.length > 0 && <ReconciliationPanel ties={data.reconciliation} />}
        </>
      )}

      {data.groups.filter((g) => g.section_key !== "working_capital_aging").map((g) => (
        <GroupBlock key={g.section_key} group={g} view={view} bucket={effBucket} kind="stock" />
      ))}

      {(() => {
        const aging = data.groups.find((g) => g.section_key === "working_capital_aging");
        if (!aging) return null;
        return (
          <>
            <SectionHeading accent={APPLICATION_COLOR}>Working Capital Aging</SectionHeading>
            <AgingPanel group={aging} view={view} bucket={effBucket} />
          </>
        );
      })()}
    </div>
  );
}
