// "ALL COMPANIES" — every company's figures side by side.
//
// The UI deliberately does NOT call this "consolidated": in accounting that
// means summed with inter-company eliminations, and nothing here is added
// across companies. Each company keeps its own figures, side by side, because
// the master sheet already carries finance's own roll-up tabs (e.g. AMATO
// TOTAL) which arrive as ordinary companies and would double-count if summed.
// (The file, component and endpoint still carry the older "consolidated" name.)
//
// Every section follows the one period picker: flows (P&L, Sales Account) are
// the period's total, stocks (Balance Sheet, Working Capital) are the position
// at its close, ratios are read exactly as the company tabs read them.
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import { FILTER_LABELS } from "@/components/ui/FilterBar";
import {
  DashboardControls, EmptyState, SectionHeading, bucketEndDate, bucketLabelsOf, bucketValue,
} from "./dashboardKit";
import type { TrendView } from "./aggregate";
import {
  formatCompact, formatINR, SUCCESS_COLOR, DANGER_COLOR, NEUTRAL_COLOR,
  REVENUE_COLOR, APPLICATION_COLOR, SOURCES_COLOR,
} from "./format";
import { useCompanyGroups } from "./useCompanyGroups";
import { MARGIN_BANDS, classifyMargin, netPatMargin } from "./margin";
import {
  CompanyTd, MoneyTd, PeriodEmpty, TOTAL_ROW, TableCard, Th, TotalLabelTd, TotalMoneyTd, asAtText, commonDate, rowBg,
  type CompanyGroup, type ConsolidatedCompany,
} from "./all-companies/shared";
import BudgetSection from "./all-companies/BudgetSection";
import IncomeTaxSection from "./all-companies/IncomeTaxSection";
import {
  BalanceSheetTrend, BudgetTrend, IncomeTaxTrend, PlTrends, RatioTrend, SalesTrend, WorkingCapitalTrend,
} from "./all-companies/TrendSections";
import { sumColumn, sumTogether, totalMargin } from "./all-companies/totals";
import SalesAccountSection from "./all-companies/SalesAccountSection";
import WorkingCapitalSection from "./all-companies/WorkingCapitalSection";
import RatioScorecard from "./all-companies/RatioScorecard";
import OverviewSection from "./all-companies/OverviewSection";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// A long page of six sections — one click to each. Scrolled to directly rather
// than via "#id" links: the page scrolls inside the app shell, not the window,
// and a hash would also land in the router's URL. The scroll margin keeps the
// sticky period bar from covering the heading it lands on.
const SECTIONS = [
  { id: "allco-overview", label: "Overview" },
  { id: "allco-pl", label: "Profit & Loss" },
  { id: "allco-budget", label: "Budget" },
  { id: "allco-sales", label: "Sales Account" },
  { id: "allco-bs", label: "Balance Sheet" },
  { id: "allco-wc", label: "Working Capital" },
  { id: "allco-ratios", label: "Key Ratios" },
];
const anchor = (id: string) => <div id={id} className="scroll-mt-32 -mb-6" />;

export default function ConsolidatedView({ refreshNonce = 0 }: { refreshNonce?: number }) {
  const { token } = useAuth();
  const [allCompanies, setAllCompanies] = useState<ConsolidatedCompany[]>([]);
  const [group, setGroup] = useState<CompanyGroup | "">("");
  const groupList = useCompanyGroups(refreshNonce);
  // A group an admin deletes while it is selected here must not leave the view
  // filtered to nothing.
  useEffect(() => {
    if (group && groupList.groups.length > 0 && !groupList.groups.some((g) => g.key === group)) setGroup("");
  }, [group, groupList.groups]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState<string>("");

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/consolidated`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load company figures");
        return r.json();
      })
      .then((d: { companies: ConsolidatedCompany[] }) => setAllCompanies(d.companies ?? []))
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [token, refreshNonce]);

  // Cut client-side from the one payload: every section below reads `companies`,
  // so the group filter reaches all of them and the period list with them.
  // Untagged companies show only under "All groups" — putting them in "Other"
  // would claim a categorisation nobody made.
  const companies = useMemo(
    () => (group ? allCompanies.filter((c) => c.company_group === group) : allCompanies),
    [allCompanies, group]
  );
  const untagged = allCompanies.filter((c) => !c.company_group).length;

  // The period picker must offer every bucket ANY company has ANY section for —
  // pooling P&L, Balance Sheet and Working Capital points gives the union in order.
  const allPoints = useMemo(
    () => companies.flatMap((c) => [...c.pl.sales, ...(c.bs.sources ?? []), ...(c.wc?.nwc ?? [])]),
    [companies]
  );
  const bucketLabels = useMemo(() => bucketLabelsOf(allPoints, "flow", view), [allPoints, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");
  // The period before the picked one, for the Overview's change under each tile.
  const prevBucket = bucketLabels[bucketLabels.indexOf(effBucket) - 1] ?? null;

  const latestOf = (series: Parameters<typeof bucketLabelsOf>[0], kind: "stock" | "flow") => {
    const labels = bucketLabelsOf(series, kind, view);
    return labels[labels.length - 1] ?? null;
  };

  const plRows = useMemo(() => companies.map((c) => {
    const sales = bucketValue(c.pl.sales, "flow", view, effBucket);
    const gross = bucketValue(c.pl.gross, "flow", view, effBucket);
    const pbitda = bucketValue(c.pl.pbitda, "flow", view, effBucket);
    const pat = bucketValue(c.pl.pat, "flow", view, effBucket);
    // Margin is a ratio of the two bucket figures — never an average of monthly
    // margins, and only meaningful on a positive base.
    const ratio = netPatMargin(sales, pat);
    const margin = ratio != null ? ratio * 100 : null;
    return { id: c.id, label: c.label, rollup: c.is_rollup, sales, gross, pbitda, pat, margin, band: classifyMargin(ratio) };
  }), [companies, view, effBucket]);

  // A balance sheet is a stock: each company's position at the close of the
  // picked period, dated by the month it actually comes from.
  const bsRows = useMemo(() => companies.map((c) => {
    const sources = bucketValue(c.bs.sources ?? [], "stock", view, effBucket);
    const application = bucketValue(c.bs.application ?? [], "stock", view, effBucket);
    const gap = sources != null && application != null ? sources - application : null;
    return { id: c.id, label: c.label, rollup: c.is_rollup, sources, application, gap, asAt: bucketEndDate(c.bs.sources ?? [], view, effBucket) };
  }), [companies, view, effBucket]);

  // Totals. Roll-up companies stay as rows but are never added (totals.ts says why
  // and how). The margin is total PAT ÷ total Sales, never an average of margins.
  const plTotalled = plRows.filter((r) => !r.rollup);
  const plTotals = {
    sales: sumColumn(plTotalled.map((r) => r.sales)), gross: sumColumn(plTotalled.map((r) => r.gross)),
    pbitda: sumColumn(plTotalled.map((r) => r.pbitda)), pat: sumColumn(plTotalled.map((r) => r.pat)),
  };
  const plTotalMargin = totalMargin(plTotalled);
  const plTotalBand = classifyMargin(plTotalMargin);
  // Sources and Application are summed over the same companies, so the total
  // balances whenever every company does.
  const bsTotalled = bsRows.filter((r) => !r.rollup);
  const bsTotal = sumTogether(bsTotalled.map((r) => [r.sources, r.application]));
  const bsTotalGap = bsTotal.values[0] != null && bsTotal.values[1] != null ? bsTotal.values[0] - bsTotal.values[1] : null;

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading all companies…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (allCompanies.length === 0) return <EmptyState>No companies available yet. Register the master files from the Data Sources tab and sync.</EmptyState>;

  const groupFilter = (
    <Select
      value={group}
      onChange={(v) => setGroup(v as CompanyGroup | "")}
      placeholder={FILTER_LABELS.companyGroup.placeholder}
      options={[{ value: "", label: FILTER_LABELS.companyGroup.all }, ...groupList.options]}
      className="min-w-[140px]"
    />
  );

  const anyPl = plRows.some((r) => r.sales != null || r.pat != null);
  const anyBs = bsRows.some((r) => r.sources != null || r.application != null);
  const bsAsAt = commonDate(bsRows.map((r) => r.asAt));

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket}
        filters={groupFilter} />

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 -mb-2">
        <p className="text-[11px] text-gray-500">
          Each company <b>as reported</b>, with a <b>Total</b> row under each table that adds the companies shown. A roll-up tab
          (such as Consolidated of Amato Group) stays as its own row and is left out of the totals, so nothing is counted twice.
          A total is over the companies that reported — ratios are never added.
          {group && <> Showing <b>{groupList.labelOf(group)}</b> companies only.</>}
          {untagged > 0 && (
            <> {untagged} {untagged === 1 ? "company is" : "companies are"} not yet in a group and show only under <b>All groups</b> — an admin sets the group from the Data Sources tab.</>
          )}
        </p>
        <nav className="no-print flex flex-wrap gap-1.5">
          {SECTIONS.map((sec) => (
            <button key={sec.id} type="button"
              onClick={() => document.getElementById(sec.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="text-[11px] font-semibold text-gray-600 bg-[#FAF7F1] border border-[#EAE3D6] rounded-full px-2.5 py-1 hover:text-gray-900 hover:border-gray-400">
              {sec.label}
            </button>
          ))}
        </nav>
      </div>

      {companies.length === 0 ? (
        <EmptyState>
          No companies are in this group yet.{" "}
          <button onClick={() => setGroup("")} className="font-semibold text-brand-orange hover:underline">Show all groups</button>
        </EmptyState>
      ) : (<>
      {anchor("allco-overview")}
      <SectionHeading accent={SOURCES_COLOR}>Overview · {effBucket || "—"}</SectionHeading>
      <OverviewSection companies={companies} view={view} bucket={effBucket} prevBucket={prevBucket} />

      {anchor("allco-pl")}
      <SectionHeading accent={REVENUE_COLOR}>Profit &amp; Loss · {effBucket || "—"}</SectionHeading>
      <PlTrends companies={companies} view={view} bucket={effBucket} />
      {!anyPl ? (
        <PeriodEmpty what="P&L figures" bucket={effBucket} onJump={setBucket}
          latest={latestOf(companies.flatMap((c) => c.pl.sales), "flow")} />
      ) : (
        <TableCard footer={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span>Classification = PAT Margin (PAT ÷ Sales) for {effBucket || "the period"}, banded:</span>
            {MARGIN_BANDS.map((b) => (
              <span key={b.key} className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm" style={{ background: b.bg }} />
                <span className="text-gray-600"><b>{b.label}</b> {b.range}</span>
              </span>
            ))}
          </div>
        }>
          <thead>
            <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
              <Th align="left">Company</Th>
              <Th>Sales</Th>
              <Th>Gross Margin</Th>
              <Th>PBITDA</Th>
              <Th>PAT</Th>
              <Th>PAT Margin</Th>
              <Th align="center">Classification</Th>
            </tr>
          </thead>
          <tbody>
            {plRows.map((r, i) => (
              <tr key={r.id} className={rowBg(i)}>
                <CompanyTd label={r.label} rollup={r.rollup} />
                <MoneyTd value={r.sales} />
                <MoneyTd value={r.gross} />
                <MoneyTd value={r.pbitda} />
                <MoneyTd value={r.pat} />
                <td className="px-4 py-3 text-right text-[13px] font-bold tabular-nums"
                  style={{ color: r.margin == null ? NEUTRAL_COLOR : r.margin >= 0 ? SUCCESS_COLOR : DANGER_COLOR }}>
                  {r.margin == null ? "—" : `${r.margin.toFixed(1)}%`}
                </td>
                <td className="px-4 py-3 text-center whitespace-nowrap">
                  {r.band ? (
                    <span className="inline-block min-w-[80px] rounded-md px-2 py-0.5 text-[11px] font-bold"
                      style={{ background: r.band.bg, color: r.band.fg }}>{r.band.label}</span>
                  ) : <span className="text-[11px] font-medium text-gray-400">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
          {plTotalled.length > 0 && (
            <tfoot>
              <tr className={TOTAL_ROW}>
                <TotalLabelTd count={plTotalled.length} excluded={plRows.length - plTotalled.length} />
                <TotalMoneyTd {...plTotals.sales} of={plTotalled.length} />
                <TotalMoneyTd {...plTotals.gross} of={plTotalled.length} />
                <TotalMoneyTd {...plTotals.pbitda} of={plTotalled.length} />
                <TotalMoneyTd {...plTotals.pat} of={plTotalled.length} />
                <td className="px-4 py-3 text-right text-[13px] font-bold tabular-nums"
                  style={{ color: plTotalMargin == null ? NEUTRAL_COLOR : plTotalMargin >= 0 ? SUCCESS_COLOR : DANGER_COLOR }}>
                  {plTotalMargin == null ? "—" : `${(plTotalMargin * 100).toFixed(1)}%`}
                </td>
                <td className="px-4 py-3 text-center whitespace-nowrap">
                  {plTotalBand ? (
                    <span className="inline-block min-w-[80px] rounded-md px-2 py-0.5 text-[11px] font-bold"
                      style={{ background: plTotalBand.bg, color: plTotalBand.fg }}>{plTotalBand.label}</span>
                  ) : <span className="text-[11px] font-medium text-gray-400">—</span>}
                </td>
              </tr>
            </tfoot>
          )}
        </TableCard>
      )}

      {anchor("allco-budget")}
      <SectionHeading accent={REVENUE_COLOR}>Budget vs Actual · {effBucket || "—"}</SectionHeading>
      <BudgetTrend companies={companies} view={view} bucket={effBucket} />
      <BudgetSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      <SectionHeading accent={DANGER_COLOR}>Income Tax Budget · close of {effBucket || "—"}</SectionHeading>
      <IncomeTaxTrend companies={companies} view={view} bucket={effBucket} />
      <IncomeTaxSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      {anchor("allco-sales")}
      <SectionHeading accent={REVENUE_COLOR}>Sales Account · {effBucket || "—"}</SectionHeading>
      <SalesTrend companies={companies} view={view} bucket={effBucket} />
      <SalesAccountSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      {anchor("allco-bs")}
      <SectionHeading accent={APPLICATION_COLOR}>Balance Sheet · close of {effBucket || "—"}</SectionHeading>
      <BalanceSheetTrend companies={companies} view={view} bucket={effBucket} />
      {!anyBs ? (
        <PeriodEmpty what="balance-sheet figures" bucket={effBucket} onJump={setBucket}
          latest={latestOf(companies.flatMap((c) => c.bs.sources ?? []), "stock")} />
      ) : (
        <TableCard footer={
          <>A balance sheet is a snapshot: {bsAsAt ? `every company as at ${asAtText(bsAsAt)}, the close of ${effBucket}` :
            `each company at the last month it reported in ${effBucket} — the dates differ, so each row shows its own`}.</>
        }>
          <thead>
            <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
              <Th align="left">Company</Th>
              <Th>Sources of Funds</Th>
              <Th>Application of Funds</Th>
              <Th align="center">Balance Check</Th>
              {!bsAsAt && <Th align="left">As at</Th>}
            </tr>
          </thead>
          <tbody>
            {bsRows.map((r, i) => {
              // Same ₹1 tolerance the Balance Sheet tab's own check uses.
              const balanced = r.gap != null && Math.abs(r.gap) < 1;
              return (
                <tr key={r.id} className={rowBg(i)}>
                  <CompanyTd label={r.label} rollup={r.rollup} />
                  <MoneyTd value={r.sources} />
                  <MoneyTd value={r.application} />
                  <td className="px-4 py-3 text-center whitespace-nowrap">
                    {r.gap == null ? (
                      <span className="text-[11px] font-medium text-gray-400">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: balanced ? `${SUCCESS_COLOR}14` : `${DANGER_COLOR}14`,
                          color: balanced ? SUCCESS_COLOR : DANGER_COLOR,
                        }}
                        title={balanced ? "Sources = Application" : `Off by ${formatINR(Math.abs(r.gap))}`}>
                        {balanced ? "✓ Balanced" : `✗ Off by ${formatCompact(Math.abs(r.gap))}`}
                      </span>
                    )}
                  </td>
                  {!bsAsAt && (
                    <td className="px-4 py-3 text-left text-[12px] font-medium text-gray-500 whitespace-nowrap">{asAtText(r.asAt)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {bsTotalled.length > 0 && (
            <tfoot>
              <tr className={TOTAL_ROW}>
                <TotalLabelTd count={bsTotalled.length} excluded={bsRows.length - bsTotalled.length} />
                <TotalMoneyTd value={bsTotal.values[0] ?? null} n={bsTotal.n} of={bsTotalled.length} />
                <TotalMoneyTd value={bsTotal.values[1] ?? null} n={bsTotal.n} of={bsTotalled.length} />
                <td className="px-4 py-3 text-center whitespace-nowrap">
                  {bsTotalGap == null ? <span className="text-[11px] font-medium text-gray-400">—</span> : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full"
                      style={{
                        background: Math.abs(bsTotalGap) < 1 ? `${SUCCESS_COLOR}14` : `${DANGER_COLOR}14`,
                        color: Math.abs(bsTotalGap) < 1 ? SUCCESS_COLOR : DANGER_COLOR,
                      }}
                      title={Math.abs(bsTotalGap) < 1 ? "Sources = Application" : `Off by ${formatINR(Math.abs(bsTotalGap))}`}>
                      {Math.abs(bsTotalGap) < 1 ? "✓ Balanced" : `✗ Off by ${formatCompact(Math.abs(bsTotalGap))}`}
                    </span>
                  )}
                </td>
                {!bsAsAt && <td />}
              </tr>
            </tfoot>
          )}
        </TableCard>
      )}

      {anchor("allco-wc")}
      <SectionHeading accent={APPLICATION_COLOR}>Working Capital · close of {effBucket || "—"}</SectionHeading>
      <WorkingCapitalTrend companies={companies} view={view} bucket={effBucket} />
      <WorkingCapitalSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      {anchor("allco-ratios")}
      <SectionHeading accent={SOURCES_COLOR}>Key Ratios · {effBucket || "—"}</SectionHeading>
      <RatioTrend companies={companies} view={view} bucket={effBucket} />
      <RatioScorecard companies={companies} view={view} bucket={effBucket} onJump={setBucket} />
      </>)}
    </div>
  );
}
