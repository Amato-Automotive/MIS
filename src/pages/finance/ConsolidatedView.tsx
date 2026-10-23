// "ALL COMPANIES" — every company's headline figures in one place.
//
// The UI deliberately does NOT call this "consolidated": in accounting that
// means summed with inter-company eliminations, and nothing here is added
// across companies. Each company keeps its own figures, side by side, because
// the master sheet already carries finance's own roll-up tabs (e.g. AMATO
// TOTAL) which arrive as ordinary companies and would double-count if summed.
// (The file, component and endpoint still carry the older "consolidated" name.)
//
// Two stacked blocks, because the two statements answer different questions and
// carry different period meanings: P&L is a flow and follows the universal
// period picker; the Balance Sheet is a stock and always reads "as at" its own
// latest period-end date, whatever the picker says.
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  DashboardControls, EmptyState, SectionHeading, bucketLabelsOf, bucketValue,
  type FinPoint,
} from "./dashboardKit";
import type { TrendView } from "./aggregate";
import {
  formatCompact, formatINR, SUCCESS_COLOR, DANGER_COLOR, NEUTRAL_COLOR,
  REVENUE_COLOR, APPLICATION_COLOR,
} from "./format";
import { MARGIN_BANDS, classifyMargin, netPatMargin } from "./margin";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface BsFigure { amount: number; period_end_date: string }
interface ConsolidatedCompany {
  id: string;
  label: string;
  pl: { sales: FinPoint[]; gross: FinPoint[]; pbitda: FinPoint[]; pat: FinPoint[] };
  bs: { sources: BsFigure | null; application: BsFigure | null };
  as_at: string | null;
}

// formatCompact deliberately returns an unsigned magnitude, so a loss-making
// company would otherwise read as a profit here. Sign it explicitly.
function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return `${n < 0 ? "−" : ""}${formatCompact(n)}`;
}

function fmtExact(n: number | null): string | undefined {
  return n == null ? undefined : formatINR(n);
}

// ISO date → "30 Jun 2026" (UTC, so a period-end date never slips a day by tz).
function fmtAsAt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function Th({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
  return (
    <th className={`px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-gray-500 text-${align} whitespace-nowrap`}>
      {children}
    </th>
  );
}

/** A right-aligned money cell. Tabular figures in consistent units compare fine
 *  down a column on their own — the exact rupee value sits in the hover title. */
function MoneyTd({ value }: { value: number | null }) {
  return (
    <td className="px-4 py-3 text-right align-middle">
      <div className="text-[13px] font-semibold text-gray-800 tabular-nums" title={fmtExact(value)}>
        {fmtMoney(value)}
      </div>
    </td>
  );
}

export default function ConsolidatedView({ refreshNonce = 0 }: { refreshNonce?: number }) {
  const { token } = useAuth();
  const [companies, setCompanies] = useState<ConsolidatedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/consolidated`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load company figures");
        return r.json();
      })
      .then((d: { companies: ConsolidatedCompany[] }) => {
        if (!alive) return;
        setCompanies(d.companies ?? []);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [token, refreshNonce]);

  // The period picker must offer every bucket ANY company has data for, not just
  // the first company's — pooling the sales points gives the union in order.
  const allSalesPoints = useMemo(
    () => companies.flatMap((c) => c.pl.sales),
    [companies]
  );
  const bucketLabels = useMemo(() => bucketLabelsOf(allSalesPoints, "flow", view), [allSalesPoints, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

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

  const bsRows = useMemo(() => companies.map((c) => {
    const sources = c.bs.sources?.amount ?? null;
    const application = c.bs.application?.amount ?? null;
    const gap = sources != null && application != null ? sources - application : null;
    return { id: c.id, label: c.label, sources, application, gap, asAt: c.as_at };
  }), [companies]);

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading all companies…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (companies.length === 0) return <EmptyState>No companies available yet. Register the master files from the Data Sources tab and sync.</EmptyState>;

  const anyPl = plRows.some((r) => r.sales != null || r.pat != null);
  const anyBs = bsRows.some((r) => r.sources != null || r.application != null);

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />

      <p className="text-[11px] text-gray-500 -mb-2">
        Each company is shown <b>as reported</b> — figures are never added across companies, so any roll-up tab in the
        master sheet appears as its own row rather than being counted twice.
      </p>

      <SectionHeading accent={REVENUE_COLOR}>Profit &amp; Loss · {effBucket || "—"}</SectionHeading>
      {!anyPl ? (
        <EmptyState>No P&amp;L figures for {effBucket || "this period"}.</EmptyState>
      ) : (
        <div className="bg-white border border-[#EAE3D6] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
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
                  <tr key={r.id} className={i % 2 === 0 ? "bg-white" : "bg-[#FAF7F1]/40"}>
                    <td className="px-4 py-3 text-[13px] font-semibold text-gray-800 whitespace-nowrap">{r.label}</td>
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
            </table>
          </div>
          {/* Same key as the P&L tab's Margin Classification panel. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-t border-[#EAE3D6] text-[11px] text-gray-500">
            <span>Classification = PAT Margin (PAT ÷ Sales) for {effBucket || "the period"}, banded:</span>
            {MARGIN_BANDS.map((b) => (
              <span key={b.key} className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm" style={{ background: b.bg }} />
                <span className="text-gray-600"><b>{b.label}</b> {b.range}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <SectionHeading accent={APPLICATION_COLOR}>Balance Sheet · last figures</SectionHeading>
      <p className="text-[11px] text-gray-500 -mt-2">
        A balance sheet is a point-in-time snapshot, so each company shows its own latest reported position — the
        <b> as at</b> date can differ between companies, and does not follow the period picker above.
      </p>
      {!anyBs ? (
        <EmptyState>No balance-sheet figures yet.</EmptyState>
      ) : (
        <div className="bg-white border border-[#EAE3D6] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
                  <Th align="left">Company</Th>
                  <Th>Sources of Funds</Th>
                  <Th>Application of Funds</Th>
                  <Th align="center">Balance Check</Th>
                  <Th align="left">As at</Th>
                </tr>
              </thead>
              <tbody>
                {bsRows.map((r, i) => {
                  // Same ₹1 tolerance the Balance Sheet tab's own check uses.
                  const balanced = r.gap != null && Math.abs(r.gap) < 1;
                  return (
                    <tr key={r.id} className={i % 2 === 0 ? "bg-white" : "bg-[#FAF7F1]/40"}>
                      <td className="px-4 py-3 text-[13px] font-semibold text-gray-800 whitespace-nowrap">{r.label}</td>
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
                      <td className="px-4 py-3 text-left text-[12px] font-medium text-gray-500 whitespace-nowrap">{fmtAsAt(r.asAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
