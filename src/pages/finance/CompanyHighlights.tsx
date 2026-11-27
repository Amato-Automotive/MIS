// "Highlights" — the first tab of a single company: what an accountant would look at
// first, before opening any statement.
//
// It reads the same per-company payload the All Companies page uses, so every figure
// agrees with that page and with the statements. Nothing here is invented: a note
// only appears when the numbers it quotes are in the sheet for the picked period, and
// a ratio is judged against the same Healthy / Watch / Concern benchmarks the
// Balance Sheet tab uses.
//
// Order is the order of a review: is it profitable, can it pay its bills, is cash
// tied up in customers or stock, is it on budget, what tax is pending — then the
// things that need attention, written out in words.
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  Card, DashboardControls, EmptyState, RAG, SectionHeading, bucketLabelsOf, bucketValue, cashCycle, cccStatus,
  formatRatio, ratioReading, ratioVerdict,
} from "./dashboardKit";
import type { TrendView } from "./aggregate";
import { DANGER_COLOR, SOURCES_COLOR, SUCCESS_COLOR, formatINR } from "./format";
import { MARGIN_BANDS, classifyMargin, netPatMargin } from "./margin";
import { slugOf } from "./budgetMath";
import { fmtMoney, type ConsolidatedCompany } from "./all-companies/shared";
import { StatTile, pctOf } from "./all-companies/OverviewSection";
import TrendChart, { SERIES_COLORS, type TrendLine } from "./all-companies/TrendChart";
import { companyPoints, labelsFor, marginByLabel, toMap } from "./all-companies/trends";
import KpiCharts from "./KpiCharts";
import { INCOME_TAX_COLUMNS } from "./all-companies/IncomeTaxSection";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const SPARK_POINTS = 7;

type Tone = "bad" | "warn" | "good";
interface Note { tone: Tone; title: string; detail: string }

const BUDGET_LINES = [
  { key: "revenue", label: "Revenue", slugs: ["revanue_income", "revenue_income"] },
  { key: "pbitda", label: "PBITDA", slugs: ["pbitda"] },
  { key: "pat", label: "PAT", slugs: ["pat"] },
] as const;

const pct1 = (v: number) => `${v.toFixed(1)}%`;
const changePct = (cur: number | null, prev: number | null) =>
  cur != null && prev != null && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;

export default function CompanyHighlights({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
  const { token } = useAuth();
  const [company, setCompany] = useState<ConsolidatedCompany | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/consolidated`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load highlights");
        return r.json();
      })
      .then((d: { companies: ConsolidatedCompany[] }) => setCompany((d.companies ?? []).find((c) => c.id === sheetSourceId) ?? null))
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [sheetSourceId, token, refreshNonce]);

  const bucketLabels = useMemo(
    () => (company ? bucketLabelsOf([...company.pl.sales, ...(company.bs.sources ?? []), ...(company.wc?.nwc ?? [])], "flow", view) : []),
    [company, view]);
  const eff = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");
  const prev = bucketLabels[bucketLabels.indexOf(eff) - 1] ?? null;

  if (loading) return <div className="text-sm text-gray-500 py-10 text-center">Loading highlights…</div>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (!company || bucketLabels.length === 0) return <EmptyState>No figures for this company yet. Sync from the Data Sources tab.</EmptyState>;

  return (
    <div className="flex flex-col gap-6">
      <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={eff} onBucket={setBucket} />
      <Body c={company} view={view} bucket={eff} prev={prev} />
    </div>
  );
}

function Body({ c, view, bucket, prev }: { c: ConsolidatedCompany; view: TrendView; bucket: string; prev: string | null }) {
  const at = (s: ConsolidatedCompany["pl"]["sales"] | undefined, b: string | null, kind: "flow" | "stock") =>
    (b && s ? bucketValue(s, kind, view, b) : null);
  const vs = prev ? `vs ${prev}` : null;

  // ── The period's figures, and the previous period's ─────────────────────────
  const f = useMemo(() => {
    const flow = (s: ConsolidatedCompany["pl"]["sales"], b: string | null) => at(s, b, "flow");
    const stock = (k: keyof ConsolidatedCompany["wc"], b: string | null) => at(c.wc?.[k], b, "stock");
    const one = (b: string | null) => ({
      sales: flow(c.pl.sales, b), gross: flow(c.pl.gross, b), pbitda: flow(c.pl.pbitda, b), pat: flow(c.pl.pat, b),
      cash: stock("cash", b), inventory: stock("inventory", b), debtors: stock("debtors", b), ca: stock("current_assets", b),
      creditors: stock("creditors", b), cl: stock("current_liabilities", b), nwc: stock("nwc", b),
      sources: at(c.bs.sources, b, "stock"), application: at(c.bs.application, b, "stock"),
    });
    return { cur: one(bucket), old: one(prev) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, view, bucket, prev]);
  const { cur, old } = f;

  const margin = netPatMargin(cur.sales, cur.pat);
  const band = classifyMargin(margin);
  const prevMargin = netPatMargin(old.sales, old.pat);
  const marginPp = margin != null && prevMargin != null ? (margin - prevMargin) * 100 : null;
  const grossPct = pctOf(cur.gross, cur.sales);
  const pbitdaPct = pctOf(cur.pbitda, cur.sales);
  const currentRatio = cur.ca != null && cur.cl != null && cur.cl > 0 ? cur.ca / cur.cl : null;

  // Sparklines: the last few periods up to the picked one.
  const sparks = useMemo(() => {
    const labels = labelsFor([c.pl.sales], "flow", view);
    const upTo = labels.slice(0, Math.max(0, labels.indexOf(bucket)) + 1);
    const last = (s: ConsolidatedCompany["pl"]["sales"], kind: "flow" | "stock") => {
      const m = toMap(s, kind, view);
      return upTo.map((l) => m.get(l)).filter((v): v is number => v != null).slice(-SPARK_POINTS);
    };
    const sm = toMap(c.pl.sales, "flow", view); const pm = toMap(c.pl.pat, "flow", view);
    return {
      sales: last(c.pl.sales, "flow"), pbitda: last(c.pl.pbitda, "flow"), pat: last(c.pl.pat, "flow"),
      cash: last(c.wc.cash, "stock"), nwc: last(c.wc.nwc, "stock"),
      margin: upTo.map((l) => { const m = netPatMargin(sm.get(l) ?? null, pm.get(l) ?? null); return m == null ? null : m * 100; })
        .filter((v): v is number => v != null).slice(-SPARK_POINTS),
    };
  }, [c, view, bucket]);

  // ── Budget and tax ──────────────────────────────────────────────────────────
  const budget = BUDGET_LINES.map((m) => {
    const li = c.budget?.lines.find((l) => (m.slugs as readonly string[]).includes(slugOf(l.line_key)));
    const plan = li ? bucketValue(li.series, "flow", view, bucket) : null;
    const actual = li ? bucketValue(c.budget!.actuals[li.line_key]?.series ?? [], "flow", view, bucket) : null;
    return { ...m, plan, actual, pct: plan != null && actual != null && plan > 0 ? (actual / plan) * 100 : null };
  });
  const tax = INCOME_TAX_COLUMNS.map((col) => {
    const it = c.budget?.tax.find((li) => slugOf(li.line_key) === col.slug);
    return { ...col, value: it ? bucketValue(it.series, "stock", view, bucket) : null };
  });
  const taxOf = (slug: string) => tax.find((t) => t.slug === slug)?.value ?? null;

  // ── Ratios, judged against the benchmarks the Balance Sheet tab uses ─────────
  const ratios = useMemo(() => (c.ratios ?? []).flatMap((cat) => cat.items.map((it) => {
    const v = ratioReading(it, view, bucket).value;
    const verdict = v != null ? ratioVerdict(it.line_key, v) : null;
    return { it, v, verdict, label: slugOf(it.line_key) === "net" ? "Net (cash cycle)" : it.line_label.replace(/\s*%\s*$/, "").trim() };
  })).filter((r) => r.verdict), [c, view, bucket]);
  const ccc = cashCycle(c.ratios ?? [], view, bucket);

  // ── What needs attention, in words ──────────────────────────────────────────
  const notes = useMemo(() => {
    const n: Note[] = [];
    const salesCh = changePct(cur.sales, old.sales);

    // Profitability
    if (cur.pat != null && cur.pat < 0) {
      n.push({ tone: "bad", title: "Loss-making", detail: `PAT is ${fmtMoney(cur.pat)} on Sales of ${fmtMoney(cur.sales)} in ${bucket}.` });
    } else if (margin != null && band) {
      const m = (margin * 100).toFixed(1);
      if (margin < 0.04) n.push({ tone: "bad", title: `PAT margin only ${m}%`, detail: `${band.label} band — under 4% of Sales is kept as profit.` });
      else if (margin >= 0.08) n.push({ tone: "good", title: `PAT margin ${m}%`, detail: `${band.label} band — healthy profitability.` });
    }
    if (cur.pbitda != null && cur.pbitda < 0) n.push({ tone: "bad", title: "Operating loss", detail: `PBITDA is ${fmtMoney(cur.pbitda)} — the business is not covering its running costs before interest and tax.` });
    const prevGross = pctOf(old.gross, old.sales);
    if (grossPct != null && prevGross != null && grossPct - prevGross <= -2) {
      n.push({ tone: "warn", title: "Gross margin slipped", detail: `${grossPct.toFixed(1)}% of Sales, down from ${prevGross.toFixed(1)}% ${vs ?? ""} — check material cost and pricing.`.trim() });
    }
    // Growth
    if (salesCh != null && salesCh <= -10) n.push({ tone: salesCh <= -20 ? "bad" : "warn", title: `Sales down ${Math.abs(salesCh).toFixed(0)}%`, detail: `${fmtMoney(cur.sales)} against ${fmtMoney(old.sales)} ${vs ?? ""}.`.trim() });
    else if (salesCh != null && salesCh >= 10) n.push({ tone: "good", title: `Sales up ${salesCh.toFixed(0)}%`, detail: `${fmtMoney(cur.sales)} against ${fmtMoney(old.sales)} ${vs ?? ""}.`.trim() });

    // Liquidity
    if (currentRatio != null) {
      if (currentRatio < 1) n.push({ tone: "bad", title: `Current ratio ${currentRatio.toFixed(2)}×`, detail: "Short-term liabilities exceed current assets — pressure to pay suppliers and lenders on time." });
      else if (currentRatio < 1.5) n.push({ tone: "warn", title: `Current ratio ${currentRatio.toFixed(2)}×`, detail: "Above 1 but under the 1.5× comfort level." });
      else n.push({ tone: "good", title: `Current ratio ${currentRatio.toFixed(2)}×`, detail: "Current assets comfortably cover short-term liabilities." });
    }
    const cashCh = changePct(cur.cash, old.cash);
    if (cashCh != null && cashCh <= -25 && old.cash != null && old.cash > 0) n.push({ tone: "warn", title: `Cash down ${Math.abs(cashCh).toFixed(0)}%`, detail: `${fmtMoney(cur.cash)} against ${fmtMoney(old.cash)} ${vs ?? ""}.`.trim() });

    // Cash tied up in customers and stock
    const debCh = changePct(cur.debtors, old.debtors);
    if (debCh != null && salesCh != null && debCh >= 10 && debCh - salesCh >= 10) {
      n.push({ tone: "warn", title: "Receivables growing faster than Sales", detail: `Debtors up ${debCh.toFixed(0)}% while Sales moved ${salesCh >= 0 ? "+" : "−"}${Math.abs(salesCh).toFixed(0)}% — collections may be slipping.` });
    }
    if (ccc) {
      const s = cccStatus(ccc.ccc);
      if (s !== "good") n.push({ tone: s === "bad" ? "bad" : "warn", title: `Cash cycle ${Math.round(ccc.ccc)} days`, detail: `Inventory ${Math.round(ccc.dio)} d + receivables ${Math.round(ccc.dso)} d − payables ${Math.round(ccc.dpo)} d. Up to 60 days is healthy.` });
    }

    // Books
    if (cur.sources != null && cur.application != null && Math.abs(cur.sources - cur.application) >= 1) {
      n.push({ tone: "bad", title: "Balance sheet does not balance", detail: `Sources and Application differ by ${formatINR(Math.abs(cur.sources - cur.application))} — check the sheet before relying on its ratios.` });
    }

    // Budget
    for (const b of budget) {
      if (b.pct == null) continue;
      if (b.pct < 90) n.push({ tone: b.pct < 75 ? "bad" : "warn", title: `${b.label} at ${b.pct.toFixed(0)}% of budget`, detail: `${fmtMoney(b.actual)} against a plan of ${fmtMoney(b.plan)}.` });
      else if (b.pct >= 100) n.push({ tone: "good", title: `${b.label} ahead of budget`, detail: `${b.pct.toFixed(0)}% — ${fmtMoney(b.actual)} against ${fmtMoney(b.plan)}.` });
    }

    // Tax
    const pending = taxOf("pending_tax_liability"); const accrued = taxOf("accumlated_income_tax");
    if (pending != null && pending > 0 && accrued != null && accrued > 0 && pending / accrued >= 0.25) {
      n.push({ tone: "warn", title: `Tax of ${fmtMoney(pending)} still to be paid`, detail: `${Math.round((pending / accrued) * 100)}% of the ${fmtMoney(accrued)} accumulated so far has not been deposited.` });
    }

    // Anything else the benchmarks call a concern (skip what is already said above)
    const said = new Set(["current_ratio"]);
    for (const r of ratios) {
      if (r.verdict?.status !== "bad" || said.has(slugOf(r.it.line_key))) continue;
      n.push({ tone: "bad", title: `${r.label} ${formatRatio(r.it.line_label, r.v as number, r.it.line_key)}`, detail: `Concern — ${r.verdict.target.toLowerCase()}.` });
    }
    const rank: Record<Tone, number> = { bad: 0, warn: 1, good: 2 };
    return n.sort((a, b) => rank[a.tone] - rank[b.tone]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, view, bucket, prev, ratios]);

  const attention = notes.filter((x) => x.tone !== "good");
  const positives = notes.filter((x) => x.tone === "good");

  // ── Charts ──────────────────────────────────────────────────────────────────
  const labels = useMemo(() => labelsFor([c.pl.sales, c.pl.gross, c.pl.pbitda, c.pl.pat], "flow", view), [c, view]);
  const lines: TrendLine[] = useMemo(() => [
    { key: "sales", label: "Sales", color: SERIES_COLORS[0], width: 3, points: companyPoints(labels, toMap(c.pl.sales, "flow", view)) },
    { key: "pbitda", label: "PBITDA", color: SERIES_COLORS[3], points: companyPoints(labels, toMap(c.pl.pbitda, "flow", view)) },
    { key: "pat", label: "PAT", color: SERIES_COLORS[1], points: companyPoints(labels, toMap(c.pl.pat, "flow", view)) },
  ], [c, labels, view]);
  const marginLine: TrendLine[] = useMemo(() => [{
    key: "margin", label: "PAT margin", color: SERIES_COLORS[0], width: 3,
    points: marginByLabel(labels, [{ sales: toMap(c.pl.sales, "flow", view), pat: toMap(c.pl.pat, "flow", view) }]),
  }], [c, labels, view]);

  const wcRows = [
    { label: "Cash & bank", cur: cur.cash, old: old.cash, note: "" },
    { label: "Inventory", cur: cur.inventory, old: old.inventory, note: "" },
    { label: "Debtors", cur: cur.debtors, old: old.debtors, note: "" },
    { label: "Current assets", cur: cur.ca, old: old.ca, note: "" },
    { label: "Creditors", cur: cur.creditors, old: old.creditors, note: "" },
    { label: "Current liabilities", cur: cur.cl, old: old.cl, note: "" },
    { label: "Net working capital", cur: cur.nwc, old: old.nwc, note: "" },
  ];
  const funnel = [
    { label: "Net Sales", value: cur.sales, fill: SERIES_COLORS[0] },
    { label: "Gross Margin", value: cur.gross, fill: SERIES_COLORS[2] },
    { label: "PBITDA", value: cur.pbitda, fill: SERIES_COLORS[3] },
    { label: "PAT", value: cur.pat, fill: SERIES_COLORS[1] },
  ];
  const funnelMax = Math.max(1, ...funnel.map((x) => Math.abs(x.value ?? 0)));
  const hasBudget = budget.some((b) => b.pct != null);
  const hasTax = tax.some((t) => t.value != null);

  const chip = (v: number | null, bg: string, fg: string) => (v == null ? null : { text: `${v.toFixed(1)}%`, bg, fg });

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading accent={SOURCES_COLOR}>Highlights · {c.label} · {bucket}</SectionHeading>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile label="Net Sales" value={fmtMoney(cur.sales)} exact={cur.sales != null ? formatINR(cur.sales) : undefined}
          delta={changePct(cur.sales, old.sales)} vs={vs} accent={SERIES_COLORS[0]} spark={sparks.sales} />
        <StatTile label="PBITDA" value={fmtMoney(cur.pbitda)} exact={cur.pbitda != null ? formatINR(cur.pbitda) : undefined}
          delta={changePct(cur.pbitda, old.pbitda)} vs={vs} accent={SERIES_COLORS[3]} spark={sparks.pbitda}
          badge={chip(pbitdaPct, `${SERIES_COLORS[3]}22`, "#8A5A00")} />
        <StatTile label="PAT" value={fmtMoney(cur.pat)} exact={cur.pat != null ? formatINR(cur.pat) : undefined}
          delta={changePct(cur.pat, old.pat)} vs={vs} accent={SERIES_COLORS[1]} spark={sparks.pat} />
        <StatTile label="PAT Margin" value={margin == null ? "—" : `${(margin * 100).toFixed(1)}%`}
          delta={marginPp} deltaUnit="pts" vs={vs} accent={band?.bg ?? SERIES_COLORS[6]} spark={sparks.margin}
          badge={band ? { text: band.label, bg: band.bg, fg: band.fg } : null} />
        <StatTile label="Cash & Bank" value={fmtMoney(cur.cash)} exact={cur.cash != null ? formatINR(cur.cash) : undefined}
          delta={changePct(cur.cash, old.cash)} vs={vs} accent={SERIES_COLORS[2]} spark={sparks.cash} />
        <StatTile label="Net Working Capital" value={fmtMoney(cur.nwc)} exact={cur.nwc != null ? formatINR(cur.nwc) : undefined}
          delta={changePct(cur.nwc, old.nwc)} vs={vs} accent={SERIES_COLORS[6]} spark={sparks.nwc}
          badge={currentRatio != null ? { text: `${currentRatio.toFixed(2)}× current`, bg: "#EEF1F5", fg: "#3B4654" } : null} />
      </div>
      <p className="text-[11px] text-gray-500 -mt-1">
        {c.label}, {bucket}. Sales, PBITDA and PAT are the period's totals; cash, working capital and the balance sheet are the position at its close.
        The chip on PBITDA is its share of Sales{grossPct != null ? `; gross margin is ${grossPct.toFixed(1)}% of Sales` : ""}. Each change compares with {prev ?? "the previous period"}.
      </p>

      <KpiCharts c={c} view={view} bucket={bucket} />

      {/* What to look at, in words */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card title={`Needs attention${attention.length ? ` · ${attention.length}` : ""}`}
            note="Read straight from this company's figures and the Healthy / Watch / Concern benchmarks — most serious first.">
            {attention.length === 0 ? (
              <p className="text-[12px] font-semibold" style={{ color: SUCCESS_COLOR }}>Nothing flagged for {bucket}.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention.map((x, i) => <NoteRow key={i} n={x} />)}
              </ul>
            )}
          </Card>
        </div>
        <Card title={`Going well${positives.length ? ` · ${positives.length}` : ""}`}>
          {positives.length === 0 ? <p className="text-[12px] text-gray-500">No standout strengths this period.</p> : (
            <ul className="flex flex-col gap-2">{positives.map((x, i) => <NoteRow key={i} n={x} />)}</ul>
          )}
        </Card>
      </div>

      {/* Trends */}
      <TrendChart title="Sales, PBITDA and PAT over time" labels={labels} fixed={lines} fmt={fmtMoney} selectedLabel={bucket}
        note={<>How this company's profit has moved with its Sales, {view === "monthly" ? "month by month" : view === "quarterly" ? "quarter by quarter" : "year by year"}.</>} />
      <TrendChart title="PAT margin over time" labels={labels} fixed={marginLine} fmt={pct1} selectedLabel={bucket} height={220}
        refLines={MARGIN_BANDS.filter((b) => b.min > -Infinity).map((b) => ({ y: b.min * 100, label: `${b.label} from ${b.min * 100}%` }))}
        note={<>PAT divided by Sales for each period. The dotted lines are the band edges management classifies against.</>} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="From Sales to PAT" note="Each step of the profit, and the share of Sales it keeps.">
          <div className="flex flex-col gap-3 mt-2">
            {funnel.map((x) => {
              const p = pctOf(x.value, cur.sales);
              return (
                <div key={x.label}>
                  <div className="flex items-baseline justify-between text-[12px] mb-1">
                    <span className="font-semibold text-gray-700">{x.label}</span>
                    <span className="tabular-nums text-gray-800"><b>{fmtMoney(x.value)}</b>{p != null && x.label !== "Net Sales" && <span className="text-gray-500"> · {p.toFixed(1)}%</span>}</span>
                  </div>
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, (Math.abs(x.value ?? 0) / funnelMax) * 100)}%`, background: (x.value ?? 0) < 0 ? DANGER_COLOR : x.fill }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Cash and working capital" note={`Position at the close of ${bucket}, with the change on ${prev ?? "the previous period"}.`}>
          <table className="w-full text-[12px] mt-1">
            <tbody>
              {wcRows.map((r) => {
                const d = changePct(r.cur, r.old);
                const strong = r.label === "Net working capital" || r.label === "Current assets" || r.label === "Current liabilities";
                return (
                  <tr key={r.label} className="border-b border-[#F3EEE4] last:border-0">
                    <td className={`py-1.5 ${strong ? "font-bold text-gray-800" : "text-gray-700"}`}>{r.label}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-gray-800" title={r.cur != null ? formatINR(r.cur) : undefined}>{fmtMoney(r.cur)}</td>
                    <td className="py-1.5 pl-2 text-right tabular-nums text-[11px] w-16" style={{ color: d == null ? "#9CA3AF" : d >= 0 ? SUCCESS_COLOR : DANGER_COLOR }}>
                      {d == null ? "—" : `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {ccc && (
            <p className="text-[11px] text-gray-500 mt-2">
              Cash cycle <b style={{ color: RAG[cccStatus(ccc.ccc)].c }}>{Math.round(ccc.ccc)} days</b> = inventory {Math.round(ccc.dio)} + receivables {Math.round(ccc.dso)} − payables {Math.round(ccc.dpo)}.
            </p>
          )}
        </Card>

        <Card title="Budget and tax" note={`Against plan for ${bucket}; tax as the running position at its close.`}>
          {!hasBudget && !hasTax ? <p className="text-[12px] text-gray-500">This company's sheet has no budget or income-tax block for {bucket}.</p> : (
            <div className="flex flex-col gap-3 mt-1">
              {budget.map((b) => {
                const color = b.pct == null ? "#9CA3AF" : b.pct >= 100 ? SUCCESS_COLOR : b.pct >= 90 ? "#B08400" : DANGER_COLOR;
                return (
                  <div key={b.key}>
                    <div className="flex items-baseline justify-between text-[12px] mb-1">
                      <span className="font-semibold text-gray-700">{b.label}</span>
                      <span className="tabular-nums text-gray-800">
                        {b.pct == null ? <span className="text-gray-400">no budget</span> : <><b style={{ color }}>{b.pct.toFixed(0)}%</b><span className="text-gray-500"> · {fmtMoney(b.actual)} of {fmtMoney(b.plan)}</span></>}
                      </span>
                    </div>
                    <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, b.pct ?? 0))}%`, background: color }} /></div>
                  </div>
                );
              })}
              {hasTax && (
                <div className="border-t border-[#F3EEE4] pt-2 flex flex-col gap-1">
                  {tax.map((t) => (
                    <div key={t.slug} className="flex justify-between text-[12px]">
                      <span className={t.slug === "pending_tax_liability" ? "font-bold text-gray-800" : "text-gray-600"}>{t.label}</span>
                      <span className="tabular-nums font-semibold text-gray-800" title={t.value != null ? formatINR(t.value) : undefined}>{fmtMoney(t.value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Ratio health */}
      {ratios.length > 0 && (
        <Card title="Ratio health" note={`Every ratio the sheet reports that has a benchmark, for ${bucket}.`}>
          <div className="flex flex-wrap gap-2 mt-1">
            {ratios.map((r) => (
              <span key={r.it.line_key} className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px]"
                style={{ background: RAG[r.verdict!.status].bg }} title={`${RAG[r.verdict!.status].t} · ${r.verdict!.target}`}>
                <span className="text-gray-700">{r.label}</span>
                <b className="tabular-nums" style={{ color: RAG[r.verdict!.status].c }}>{formatRatio(r.it.line_label, r.v as number, r.it.line_key)}</b>
              </span>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 mt-3">
            <span className="font-semibold" style={{ color: RAG.good.c }}>Healthy</span> · <span className="font-semibold" style={{ color: RAG.warn.c }}>Watch</span> · <span className="font-semibold" style={{ color: RAG.bad.c }}>Concern</span> — the same benchmarks as the Balance Sheet tab. Hover a ratio for its target.
          </p>
        </Card>
      )}
    </div>
  );
}

function NoteRow({ n }: { n: Note }) {
  const color = n.tone === "bad" ? DANGER_COLOR : n.tone === "warn" ? "#B08400" : SUCCESS_COLOR;
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-3 py-2" style={{ background: n.tone === "bad" ? RAG.bad.bg : n.tone === "warn" ? RAG.warn.bg : RAG.good.bg }}>
      <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-gray-800">{n.title}</div>
        <div className="text-[12px] text-gray-600 leading-snug">{n.detail}</div>
      </div>
    </li>
  );
}
