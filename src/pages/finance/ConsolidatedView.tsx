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
import { MARGIN_BANDS, classifyMargin, netPatMargin } from "./margin";
import {
  COMPANY_GROUP_LABELS, COMPANY_GROUP_OPTIONS, CompanyTd, MoneyTd, PeriodEmpty, TableCard, Th, asAtText, commonDate, rowBg,
  type CompanyGroup, type ConsolidatedCompany,
} from "./all-companies/shared";
import BudgetSection from "./all-companies/BudgetSection";
import SalesAccountSection from "./all-companies/SalesAccountSection";
import WorkingCapitalSection from "./all-companies/WorkingCapitalSection";
import RatioScorecard from "./all-companies/RatioScorecard";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// A long page of six sections — one click to each. Scrolled to directly rather
// than via "#id" links: the page scrolls inside the app shell, not the window,
// and a hash would also land in the router's URL. The scroll margin keeps the
// sticky period bar from covering the heading it lands on.
const SECTIONS = [
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
    return { id: c.id, label: c.label, sales, gross, pbitda, pat, margin, band: classifyMargin(ratio) };
  }), [companies, view, effBucket]);

  // A balance sheet is a stock: each company's position at the close of the
  // picked period, dated by the month it actually comes from.
  const bsRows = useMemo(() => companies.map((c) => {
    const sources = bucketValue(c.bs.sources ?? [], "stock", view, effBucket);
    const application = bucketValue(c.bs.application ?? [], "stock", view, effBucket);
    const gap = sources != null && application != null ? sources - application : null;
    return { id: c.id, label: c.label, sources, application, gap, asAt: bucketEndDate(c.bs.sources ?? [], view, effBucket) };
  }), [companies, view, effBucket]);

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading all companies…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (allCompanies.length === 0) return <EmptyState>No companies available yet. Register the master files from the Data Sources tab and sync.</EmptyState>;

  const groupFilter = (
    <Select
      value={group}
      onChange={(v) => setGroup(v as CompanyGroup | "")}
      placeholder={FILTER_LABELS.companyGroup.placeholder}
      options={[{ value: "", label: FILTER_LABELS.companyGroup.all }, ...COMPANY_GROUP_OPTIONS]}
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
          Each company <b>as reported</b> — nothing is added across companies, so a roll-up tab appears as its own row.
          {group && <> Showing <b>{COMPANY_GROUP_LABELS[group]}</b> companies only.</>}
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
      {anchor("allco-pl")}
      <SectionHeading accent={REVENUE_COLOR}>Profit &amp; Loss · {effBucket || "—"}</SectionHeading>
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
                <CompanyTd label={r.label} />
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
        </TableCard>
      )}

      {anchor("allco-budget")}
      <SectionHeading accent={REVENUE_COLOR}>Budget vs Actual · {effBucket || "—"}</SectionHeading>
      <BudgetSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      {anchor("allco-sales")}
      <SectionHeading accent={REVENUE_COLOR}>Sales Account · {effBucket || "—"}</SectionHeading>
      <SalesAccountSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      {anchor("allco-bs")}
      <SectionHeading accent={APPLICATION_COLOR}>Balance Sheet · close of {effBucket || "—"}</SectionHeading>
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
                  <CompanyTd label={r.label} />
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
        </TableCard>
      )}

      {anchor("allco-wc")}
      <SectionHeading accent={APPLICATION_COLOR}>Working Capital · close of {effBucket || "—"}</SectionHeading>
      <WorkingCapitalSection companies={companies} view={view} bucket={effBucket} onJump={setBucket} />

      {anchor("allco-ratios")}
      <SectionHeading accent={SOURCES_COLOR}>Key Ratios · {effBucket || "—"}</SectionHeading>
      <RatioScorecard companies={companies} view={view} bucket={effBucket} onJump={setBucket} />
      </>)}
    </div>
  );
}
