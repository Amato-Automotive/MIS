// The line charts of the All Companies page, one set per section.
//
// Each sits directly above its section's table, follows the same view
// (monthly / quarterly / yearly) and the same group filter, and is built from the
// same rules as the table's Total row (trends.ts / totals.ts) — so a chart and
// its table agree. Roll-up companies are not plotted, for the reason they are not
// totalled: they are already the sum of other companies.
//
// The charts answer the question a table cannot — "which way is it moving?" —
// and each says in a line what its lines are and how they are worked out.
import { useMemo, useState, type ReactNode } from "react";
import { cashCycle, formatRatio, ratioReading, ratioTarget, type RatioItem } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { MARGIN_BANDS } from "../margin";
import { slugOf } from "../budgetMath";
import { fmtMoney, totalled, type ConsolidatedCompany } from "./shared";
import TrendChart, { COMPANY_KEY, SERIES_COLORS, TOTAL_INK, type TrendCandidate, type TrendLine } from "./TrendChart";
import {
  companyPoints, labelsFor, marginByLabel, sumByLabel, sumTogetherByLabel, toMap, type LabelMap, type TrendPoint,
} from "./trends";
import { INCOME_TAX_COLUMNS } from "./IncomeTaxSection";

interface Props { companies: ConsolidatedCompany[]; view: TrendView; bucket: string }

const BLUE = SERIES_COLORS[0];
const ORANGE = SERIES_COLORS[1];

const shortName = (c: ConsolidatedCompany) => c.short_label || c.label;

/** A company as a line the viewer can add: keyed so the tooltip knows it is one. */
function companyLine(c: ConsolidatedCompany, labels: string[], map: LabelMap): TrendCandidate {
  return { key: `${COMPANY_KEY}${c.id}`, label: shortName(c), title: c.label, points: companyPoints(labels, map) };
}

/** Small segmented switch, in the same style as the rest of the page's controls. */
function Seg<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="no-print flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5 shrink-0">
      {options.map((o) => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
            value === o.key ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SELECT_CLS = "no-print text-[11px] font-semibold text-gray-700 bg-white border border-[#EAE3D6] rounded-lg px-2 py-1 max-w-[16rem]";
const pct1 = (v: number) => `${v.toFixed(1)}%`;
const days = (v: number) => `${Math.round(v).toLocaleString("en-IN")} days`;

const GROUP_NOTE = "The Total is the sum of the companies that reported each period (roll-ups left out), the same as the table's Total row.";

// ── Profit & Loss ────────────────────────────────────────────────────────────
const PL_METRICS = [
  { key: "sales", label: "Sales", pick: (c: ConsolidatedCompany) => c.pl.sales },
  { key: "gross", label: "Gross Margin", pick: (c: ConsolidatedCompany) => c.pl.gross },
  { key: "pbitda", label: "PBITDA", pick: (c: ConsolidatedCompany) => c.pl.pbitda },
  { key: "pat", label: "PAT", pick: (c: ConsolidatedCompany) => c.pl.pat },
] as const;
type PlKey = (typeof PL_METRICS)[number]["key"];

export function PlTrends({ companies, view, bucket }: Props) {
  const [metric, setMetric] = useState<PlKey>("sales");
  const eligible = useMemo(() => totalled(companies), [companies]);
  const labels = useMemo(
    () => labelsFor(eligible.flatMap((c) => PL_METRICS.map((m) => m.pick(c))), "flow", view), [eligible, view]);
  const maps = useMemo(() => eligible.map((c) => ({
    c, sales: toMap(c.pl.sales, "flow", view), gross: toMap(c.pl.gross, "flow", view),
    pbitda: toMap(c.pl.pbitda, "flow", view), pat: toMap(c.pl.pat, "flow", view),
  })), [eligible, view]);

  const label = PL_METRICS.find((m) => m.key === metric)!.label;
  const fixed: TrendLine[] = [{ key: "total", label: `Total ${label}`, color: TOTAL_INK, width: 3, points: sumByLabel(labels, maps.map((m) => m[metric])) }];
  const candidates = maps.map((m) => companyLine(m.c, labels, m[metric]));

  const margin: TrendLine[] = [{ key: "margin", label: "Total PAT margin", color: BLUE, width: 3,
    points: marginByLabel(labels, maps.map((m) => ({ sales: m.sales, pat: m.pat }))) }];

  return (
    <div className="flex flex-col gap-4">
      <TrendChart title={`${label} over time`} labels={labels} fixed={fixed} candidates={candidates} fmt={fmtMoney}
        selectedLabel={bucket}
        right={<Seg value={metric} onChange={setMetric} options={PL_METRICS.map((m) => ({ key: m.key, label: m.label }))} />}
        note={<>How {label} has moved, month by month, quarter by quarter or year by year as the view is set. The dark line is the
          group; add companies below it to see who is driving the change. {GROUP_NOTE} Exact figures are in the table below.</>} />
      <TrendChart title="Group PAT margin over time" labels={labels} fixed={margin} fmt={pct1} selectedLabel={bucket}
        refLines={MARGIN_BANDS.filter((b) => b.min > -Infinity).map((b) => ({ y: b.min * 100, label: `${b.label} from ${b.min * 100}%` }))}
        height={240}
        note={<>Total PAT divided by total Sales for each period — worked out from the totals, never an average of the companies'
          own margins. The dotted lines are the band edges management classifies against (Red, Orange, Green, Blue).</>} />
    </div>
  );
}

// ── Budget ───────────────────────────────────────────────────────────────────
const BUDGET_METRICS = [
  { key: "revenue", label: "Revenue", slugs: ["revanue_income", "revenue_income"] },
  { key: "pbitda", label: "PBITDA", slugs: ["pbitda"] },
  { key: "pat", label: "PAT", slugs: ["pat"] },
] as const;
type BudgetKey = (typeof BUDGET_METRICS)[number]["key"];

export function BudgetTrend({ companies, view, bucket }: Props) {
  const [metric, setMetric] = useState<BudgetKey>("revenue");
  const spec = BUDGET_METRICS.find((m) => m.key === metric)!;
  const eligible = useMemo(() => totalled(companies).filter((c) => (c.budget?.lines.length ?? 0) > 0), [companies]);

  const per = useMemo(() => eligible.map((c) => {
    const it = c.budget!.lines.find((li) => (spec.slugs as readonly string[]).includes(slugOf(li.line_key)));
    return { budget: toMap(it?.series, "flow", view), actual: toMap(it ? c.budget!.actuals[it.line_key]?.series : undefined, "flow", view) };
  }), [eligible, spec, view]);
  // The periods the BUDGET covers — comparing against a month nobody budgeted would read as a miss.
  const labels = useMemo(
    () => labelsFor(eligible.flatMap((c) => c.budget!.lines.map((li) => li.series)), "flow", view), [eligible, view]);

  // Actual and budget are added over the companies that have BOTH in the period —
  // the table's Total row does the same — so the two lines compare like with like.
  const [budgetPts, actualPts] = useMemo(() => {
    const [a, b] = sumTogetherByLabel(labels, per.map((p) => [p.actual, p.budget]));
    // `of` = the companies that have a budget that period, so a hollow Actual dot
    // means "some companies have a budget but no actual yet".
    for (const l of labels) {
      const of = per.filter((p) => p.budget.has(l)).length;
      const fix = (m: Map<string, TrendPoint>) => { const p = m.get(l); if (p) m.set(l, { ...p, of }); };
      fix(a); fix(b);
    }
    return [b, a] as const;
  }, [labels, per]);

  const fixed: TrendLine[] = [
    { key: "budget", label: `Budget · ${spec.label}`, color: TOTAL_INK, dashed: true, width: 2.5, points: budgetPts },
    { key: "actual", label: `Actual · ${spec.label}`, color: BLUE, width: 3, points: actualPts },
  ];
  return (
    <TrendChart title={`Budget vs actual over time · ${spec.label}`} labels={labels} fixed={fixed} fmt={fmtMoney} selectedLabel={bucket}
      right={<Seg value={metric} onChange={setMetric} options={BUDGET_METRICS.map((m) => ({ key: m.key, label: m.label }))} />}
      note={<>The group's plan (dashed) against what was actually reported (solid). Both lines add only the companies that have a budget
        <b> and</b> an actual for that period, so they compare like with like — the same rule as the Budget table's Total row.
        Where the lines meet, the group is on plan.</>} />
  );
}

// ── Income tax ───────────────────────────────────────────────────────────────
export function IncomeTaxTrend({ companies, view, bucket }: Props) {
  const eligible = useMemo(() => totalled(companies).filter((c) => (c.budget?.tax.length ?? 0) > 0), [companies]);
  const perCompany = useMemo(() => eligible.map((c) => INCOME_TAX_COLUMNS.map((col) =>
    toMap(c.budget!.tax.find((li) => slugOf(li.line_key) === col.slug)?.series, "stock", view))), [eligible, view]);
  const labels = useMemo(
    () => labelsFor(eligible.flatMap((c) => c.budget!.tax.map((li) => li.series)), "stock", view), [eligible, view]);
  const sums = useMemo(() => sumTogetherByLabel(labels, perCompany), [labels, perCompany]);
  const fixed: TrendLine[] = INCOME_TAX_COLUMNS.map((col, i) => ({
    key: col.slug, label: col.label, color: SERIES_COLORS[i], width: 2.5, points: sums[i],
  }));
  return (
    <TrendChart title="Income tax position over time" labels={labels} fixed={fixed} fmt={fmtMoney} selectedLabel={bucket}
      note={<>The group's running tax position: profit before tax accumulated so far, the tax on it, what has been deposited (TDS/TCS and
        advance tax) and what is still owed. Each is a position at the period's end, not a flow. The four lines add the same companies, so
        pending tax is always accumulated tax less tax deposited.</>} />
  );
}

// ── Sales account ────────────────────────────────────────────────────────────
export function SalesTrend({ companies, view, bucket }: Props) {
  const [mode, setMode] = useState<"channel" | "company">("channel");
  const eligible = useMemo(() => totalled(companies), [companies]);
  const labels = useMemo(
    () => labelsFor(eligible.flatMap((c) => [c.sales_total, ...c.sales_channels.map((ch) => ch.series)]), "flow", view), [eligible, view]);
  const totals = useMemo(() => sumByLabel(labels, eligible.map((c) => toMap(c.sales_total, "flow", view))), [labels, eligible, view]);
  const total: TrendLine = { key: "total", label: "Total Sales", color: TOTAL_INK, width: 3, points: totals };

  const channels = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; item_no: number }>();
    for (const c of eligible) for (const ch of c.sales_channels) {
      const prev = seen.get(ch.key);
      seen.set(ch.key, { key: ch.key, label: prev?.label ?? ch.label, item_no: Math.min(ch.item_no, prev?.item_no ?? Infinity) });
    }
    return [...seen.values()].sort((a, b) => a.item_no - b.item_no).slice(0, SERIES_COLORS.length);
  }, [eligible]);

  const channelLines: TrendLine[] = useMemo(() => channels.map((ch, i) => {
    const pts = sumByLabel(labels, eligible.map((c) => toMap(c.sales_channels.find((x) => x.key === ch.key)?.series, "flow", view)));
    // `of` = companies that have this channel: a company with no such channel is
    // not "missing" from it, so it must not draw as a part-covered total.
    return { key: `ch:${ch.key}`, label: ch.label, color: SERIES_COLORS[i], points: new Map([...pts].map(([l, p]) => [l, { ...p, of: p.n }])) };
  }), [channels, labels, eligible, view]);

  const candidates = eligible.map((c) => companyLine(c, labels, toMap(c.sales_total, "flow", view)));

  return (
    <TrendChart title={mode === "channel" ? "Sales by channel over time" : "Sales by company over time"} labels={labels}
      fixed={mode === "channel" ? [total, ...channelLines] : [total]}
      candidates={mode === "company" ? candidates : []} fmt={fmtMoney} selectedLabel={bucket}
      right={<Seg value={mode} onChange={setMode} options={[{ key: "channel", label: "By channel" }, { key: "company", label: "By company" }]} />}
      note={mode === "channel"
        ? <>Group Sales split by the channels in each company's Sales Accounts (Branch Purchase sits below the Total and is not a sale). The
            dark line is total Sales; each coloured line is one channel added across the companies that have it. {GROUP_NOTE}</>
        : <>Group Sales (dark) with the companies you pick. {GROUP_NOTE}</>} />
  );
}

// ── Balance Sheet ────────────────────────────────────────────────────────────
export function BalanceSheetTrend({ companies, view, bucket }: Props) {
  const [mode, setMode] = useState<"group" | "company">("group");
  const eligible = useMemo(() => totalled(companies), [companies]);
  const labels = useMemo(
    () => labelsFor(eligible.flatMap((c) => [c.bs.sources, c.bs.application]), "stock", view), [eligible, view]);
  const maps = useMemo(() => eligible.map((c) => ({ c, sources: toMap(c.bs.sources, "stock", view), application: toMap(c.bs.application, "stock", view) })), [eligible, view]);
  const [sources, application] = useMemo(
    () => sumTogetherByLabel(labels, maps.map((m) => [m.sources, m.application])), [labels, maps]);

  const group: TrendLine[] = [
    { key: "sources", label: "Sources of Funds", color: BLUE, width: 3, points: sources },
    { key: "application", label: "Application of Funds", color: ORANGE, width: 2.5, dashed: true, points: application },
  ];
  const total: TrendLine = { key: "total", label: "Total Sources of Funds", color: TOTAL_INK, width: 3, points: sources };
  const candidates = maps.map((m) => companyLine(m.c, labels, m.sources));

  return (
    <TrendChart title={mode === "group" ? "Balance sheet over time" : "Sources of Funds by company over time"} labels={labels}
      fixed={mode === "group" ? group : [total]} candidates={mode === "company" ? candidates : []} fmt={fmtMoney} selectedLabel={bucket}
      right={<Seg value={mode} onChange={setMode} options={[{ key: "group", label: "Group" }, { key: "company", label: "By company" }]} />}
      note={mode === "group"
        ? <>Where the group's money comes from (Sources) against where it is held (Application), at each period's end. A balance sheet
            balances, so the two lines sit on top of each other — a gap between them is a problem to chase. They add the same companies.</>
        : <>The group's Sources of Funds (dark) with the companies you pick — who is growing the balance sheet. {GROUP_NOTE}</>} />
  );
}

// ── Working capital ──────────────────────────────────────────────────────────
export function WorkingCapitalTrend({ companies, view, bucket }: Props) {
  const [mode, setMode] = useState<"group" | "company">("group");
  const eligible = useMemo(() => totalled(companies), [companies]);
  const labels = useMemo(
    () => labelsFor(eligible.flatMap((c) => [c.wc.current_assets, c.wc.current_liabilities, c.wc.nwc]), "stock", view), [eligible, view]);
  const maps = useMemo(() => eligible.map((c) => ({
    c, ca: toMap(c.wc.current_assets, "stock", view), cl: toMap(c.wc.current_liabilities, "stock", view), nwc: toMap(c.wc.nwc, "stock", view),
  })), [eligible, view]);
  // Same rule as the table: a company counts only if it reports all three, so the
  // lines satisfy NWC = Current Assets − Current Liabilities.
  const [ca, cl, nwc] = useMemo(
    () => sumTogetherByLabel(labels, maps.map((m) => [m.ca, m.cl, m.nwc])), [labels, maps]);

  const group: TrendLine[] = [
    { key: "ca", label: "Current Assets", color: BLUE, width: 2.5, points: ca },
    { key: "cl", label: "Current Liabilities", color: ORANGE, width: 2.5, points: cl },
    { key: "nwc", label: "Net Working Capital", color: TOTAL_INK, width: 3, points: nwc },
  ];
  const total: TrendLine = { key: "total", label: "Total Net Working Capital", color: TOTAL_INK, width: 3, points: nwc };
  const candidates = maps.map((m) => companyLine(m.c, labels, m.nwc));

  // Cash conversion cycle: days, so companies of any size compare. Not added —
  // a ratio has no total — and benchmarked on the page's own bands.
  const cccLabels = useMemo(
    () => labelsFor(eligible.flatMap((c) => (c.ratios ?? []).flatMap((cat) => cat.items.map((it) => it.series))), "stock", view), [eligible, view]);
  const cccCandidates: TrendCandidate[] = useMemo(() => eligible.map((c) => ({
    key: `${COMPANY_KEY}${c.id}`, label: shortName(c), title: c.label,
    points: new Map(cccLabels.map((l) => {
      const v = cashCycle(c.ratios ?? [], view, l)?.ccc;
      return [l, { value: v ?? null, n: v == null ? 0 : 1, of: 1 }] as const;
    })),
  })), [eligible, cccLabels, view]);

  return (
    <div className="flex flex-col gap-4">
      <TrendChart title={mode === "group" ? "Working capital over time" : "Net Working Capital by company over time"} labels={labels}
        fixed={mode === "group" ? group : [total]} candidates={mode === "company" ? candidates : []} fmt={fmtMoney} selectedLabel={bucket}
        right={<Seg value={mode} onChange={setMode} options={[{ key: "group", label: "Group" }, { key: "company", label: "By company" }]} />}
        note={mode === "group"
          ? <>What the group has tied up short-term (Current Assets), what it owes short-term (Current Liabilities) and the difference
              (Net Working Capital, dark), at each period's end. A company is added only if it reports all three, as in the table's Total row.</>
          : <>The group's Net Working Capital (dark) with the companies you pick. {GROUP_NOTE}</>} />
      <TrendChart title="Cash conversion cycle over time" labels={cccLabels} fixed={[]} candidates={cccCandidates} fmt={days} selectedLabel={bucket}
        refLines={[{ y: 60, label: "60 days · up to here is Healthy" }, { y: 90, label: "90 days · beyond is a Concern" }]} height={260}
        note={<>Days cash is tied up: inventory days + receivable days − payable days. Shorter is better. Days compare companies of any size,
          so this chart has no group line — a ratio cannot be added. The longest-cycle companies are on by default.</>} />
    </div>
  );
}

// ── Key ratios ───────────────────────────────────────────────────────────────
interface RatioChoice { id: string; cat: string; slug: string; label: string; lineKey: string }

function ratioChoices(companies: ConsolidatedCompany[]): RatioChoice[] {
  const cats = new Map<string, Map<string, RatioChoice>>();
  for (const c of companies) for (const cat of c.ratios ?? []) {
    if (!cats.has(cat.label)) cats.set(cat.label, new Map());
    for (const it of cat.items) {
      const slug = slugOf(it.line_key);
      // The sheet labels the cash cycle just "Net".
      const label = slug === "net" ? "Net (cash cycle)" : it.line_label.replace(/\s*%\s*$/, "").trim();
      if (!cats.get(cat.label)!.has(slug)) cats.get(cat.label)!.set(slug, { id: `${cat.label}|${slug}`, cat: cat.label, slug, label, lineKey: it.line_key });
    }
  }
  return [...cats.values()].flatMap((m) => [...m.values()]);
}

export function RatioTrend({ companies, view, bucket }: Props) {
  const eligible = useMemo(() => totalled(companies), [companies]);
  const choices = useMemo(() => ratioChoices(eligible), [eligible]);
  const [choiceId, setChoiceId] = useState<string>("");
  const choice = choices.find((c) => c.id === choiceId) ?? choices[0];

  const items = useMemo(() => eligible.map((c) => {
    const m = new Map<string, RatioItem>();
    for (const cat of c.ratios ?? []) for (const it of cat.items) m.set(`${cat.label}|${slugOf(it.line_key)}`, it);
    return m;
  }), [eligible]);

  const labels = useMemo(() => !choice ? [] : labelsFor(items.map((m) => m.get(choice.id)?.series), "stock", view), [items, choice, view]);
  const candidates: TrendCandidate[] = useMemo(() => !choice ? [] : eligible.map((c, i) => {
    const it = items[i].get(choice.id);
    return {
      key: `${COMPANY_KEY}${c.id}`, label: shortName(c), title: c.label,
      points: new Map(labels.map((l) => {
        const v = it ? ratioReading(it, view, l).value : null;
        return [l, { value: v, n: v == null ? 0 : 1, of: 1 }] as const;
      })),
    };
  }), [eligible, items, choice, labels, view]);

  if (!choice) return null;
  const fmt = (v: number) => formatRatio(choice.label, v, choice.lineKey);
  const target = ratioTarget(choice.lineKey);
  const select: ReactNode = (
    <select value={choice.id} onChange={(e) => setChoiceId(e.target.value)} className={SELECT_CLS}>
      {[...new Set(choices.map((c) => c.cat))].map((cat) => (
        <optgroup key={cat} label={cat}>
          {choices.filter((c) => c.cat === cat).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
  return (
    <TrendChart title={`${choice.label} over time`} labels={labels} fixed={[]} candidates={candidates} fmt={fmt} selectedLabel={bucket}
      right={select}
      note={<>One ratio at a time, a line per company you pick — choose the ratio at the top right. A ratio is not additive, so there is no group
        line. A quarter or year is worked out from that period's own figures, exactly as in the scorecard below.
        {target && <> {target}.</>}</>} />
  );
}
