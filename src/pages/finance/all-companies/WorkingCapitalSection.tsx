// §5 Working Capital across companies — what each company has tied up at the
// close of the period, and how long its cash takes to come back.
//
// The table is the balance (₹, a stock: the period's closing month). The chart
// is the cash conversion cycle (days), which compares companies of very
// different size on equal terms — the reason it is the one chart here.
import { useMemo } from "react";
import { Card, RAG, bucketEndDate, bucketLabelsOf, bucketValue, cashCycle, cccStatus } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import {
  BarRow, CompanyTd, MoneyTd, PeriodEmpty, TableCard, Th, TipBox, asAtText, commonDate, rowBg,
  type ConsolidatedCompany, type WcKey,
} from "./shared";

const ASSET_COLS: [WcKey, string][] = [["cash", "Cash & Bank"], ["inventory", "Inventory"], ["debtors", "Debtors"], ["current_assets", "Total"]];
const LIAB_COLS: [WcKey, string][] = [["creditors", "Creditors"], ["current_liabilities", "Total"]];
const WC_KEYS: WcKey[] = [...ASSET_COLS, ...LIAB_COLS].map(([k]) => k).concat("nwc");

const days = (v: number) => `${Math.round(v).toLocaleString("en-IN")} days`;

// A near-dormant company's cycle can run to thousands of days (AMATO DL, Q2
// FY27: almost no sales against a standing balance) and would flatten every
// other bar. The scale stops at the longest cycle within a year; a longer one
// runs to the edge, and its exact figure stays beside it.
const SCALE_CAP_DAYS = 365;
const roundUp = (v: number) => Math.ceil(v / 10) * 10;

export default function WorkingCapitalSection({ companies, view, bucket, onJump }:
  { companies: ConsolidatedCompany[]; view: TrendView; bucket: string; onJump: (label: string) => void }) {
  const rows = useMemo(() => companies.map((c) => {
    const values = Object.fromEntries(
      WC_KEYS.map((k) => [k, bucketValue(c.wc[k] ?? [], "stock", view, bucket)])
    ) as Record<WcKey, number | null>;
    const asAt = bucketEndDate(c.wc.nwc?.length ? c.wc.nwc : c.wc.current_assets ?? [], view, bucket);
    return { id: c.id, label: c.label, values, asAt };
  }), [companies, view, bucket]);
  const sharedAsAt = commonDate(rows.map((r) => r.asAt));

  const latest = useMemo(() => {
    const labels = bucketLabelsOf(companies.flatMap((c) => [...(c.wc.nwc ?? []), ...(c.wc.current_assets ?? [])]), "stock", view);
    return labels[labels.length - 1] ?? null;
  }, [companies, view]);

  // Longest cycle first — the companies with the most cash locked up lead.
  const cycles = useMemo(() => companies
    .map((c) => ({ id: c.id, label: c.label, cycle: cashCycle(c.ratios ?? [], view, bucket) }))
    .filter((r): r is { id: string; label: string; cycle: NonNullable<typeof r.cycle> } => r.cycle != null)
    .sort((a, b) => b.cycle.ccc - a.cycle.ccc), [companies, view, bucket]);
  const noCycle = companies.filter((c) => !cycles.some((r) => r.id === c.id)).map((c) => c.label);

  const values = cycles.map((r) => r.cycle.ccc);
  const within = values.filter((v) => v <= SCALE_CAP_DAYS);
  const hi = Math.max(10, roundUp(within.length ? Math.max(...within) : SCALE_CAP_DAYS));
  const lo = Math.min(0, -roundUp(-Math.min(0, ...values)));
  const span = hi - lo;
  const zeroAt = (-lo / span) * 100;
  const clipped = cycles.filter((r) => r.cycle.ccc > hi).map((r) => r.label);

  if (rows.every((r) => Object.values(r.values).every((v) => v == null))) {
    return <PeriodEmpty what="working-capital figures" bucket={bucket} latest={latest} onJump={onJump} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <TableCard footer={
        <>{sharedAsAt ? `As at ${asAtText(sharedAsAt)}, ` : "At each company's last reported month in the period, "}from §5 Working
          Capital. Net Working Capital = Current Assets − Current Liabilities; below zero, short-term creditors fund more than the
          current assets cover.</>
      }>
        <thead>
          <tr className="bg-[#FAF7F1]">
            <th />
            <th colSpan={ASSET_COLS.length} className="px-4 pt-3 text-[10px] font-bold uppercase tracking-wider text-gray-600 text-center border-b border-[#EAE3D6]">Current Assets</th>
            <th colSpan={LIAB_COLS.length} className="px-4 pt-3 text-[10px] font-bold uppercase tracking-wider text-gray-600 text-center border-b border-[#EAE3D6]">Current Liabilities</th>
            <th colSpan={sharedAsAt ? 1 : 2} />
          </tr>
          <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
            <Th align="left">Company</Th>
            {ASSET_COLS.map(([k, l]) => <Th key={k}>{l}</Th>)}
            {LIAB_COLS.map(([k, l]) => <Th key={k}>{l}</Th>)}
            <Th>Net Working Capital</Th>
            {!sharedAsAt && <Th align="left">As at</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={rowBg(i)}>
              <CompanyTd label={r.label} />
              {ASSET_COLS.map(([k]) => <MoneyTd key={k} value={r.values[k]} />)}
              {LIAB_COLS.map(([k]) => <MoneyTd key={k} value={r.values[k]} />)}
              <MoneyTd value={r.values.nwc} />
              {!sharedAsAt && (
                <td className="px-4 py-3 text-left text-[12px] font-medium text-gray-500 whitespace-nowrap">{asAtText(r.asAt)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </TableCard>

      <Card title="Cash conversion cycle by company"
        note={`Days cash is tied up in ${bucket}: inventory days + receivable days − payable days. Shorter is better.`}>
        {cycles.length === 0 ? (
          <div className="text-[12px] text-gray-500 py-4">No company has inventory, receivable and payable days for {bucket}.</div>
        ) : (
          <div className="relative flex flex-col gap-3 mt-1">
            {cycles.map((r) => {
              const { dio, dso, dpo, ccc } = r.cycle;
              const status = cccStatus(ccc);
              const shown = Math.min(ccc, hi);
              const left = ccc >= 0 ? zeroAt : ((ccc - lo) / span) * 100;
              const width = (Math.abs(shown) / span) * 100;
              return (
                <BarRow key={r.id} name={r.label} value={`${ccc > hi ? "› " : ""}${days(ccc)}`}
                  hover={
                    <TipBox title={`${r.label} · ${days(ccc)}`}>
                      <div className="text-gray-600 tabular-nums">Inventory {days(dio)}</div>
                      <div className="text-gray-600 tabular-nums">+ Receivables {days(dso)}</div>
                      <div className="text-gray-600 tabular-nums">− Payables {days(dpo)}</div>
                      <div className="mt-1 font-semibold" style={{ color: RAG[status].c }}>{RAG[status].t}</div>
                    </TipBox>
                  }>
                  <div className="relative h-3 rounded-full bg-[#F3EEE4]">
                    {lo < 0 && <div className="absolute top-[-3px] bottom-[-3px] w-px bg-gray-400" style={{ left: `${zeroAt}%` }} />}
                    <div className={`absolute top-0 h-3 ${ccc > hi ? "rounded-l-full" : "rounded-full"}`}
                      style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%`, background: RAG[status].c }} />
                  </div>
                </BarRow>
              );
            })}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-gray-500 mt-4">
          How long cash sits in stock and with customers before it comes back, net of the credit suppliers give — from each
          company's turnover-day ratios{view !== "monthly" ? ", worked out for the whole period" : ""}. Below zero, suppliers
          fund the whole cycle.{" "}
          <span style={{ color: RAG.good.c }} className="font-semibold">≤ 60 days Healthy</span> ·{" "}
          <span style={{ color: RAG.warn.c }} className="font-semibold">61–90 Watch</span> ·{" "}
          <span style={{ color: RAG.bad.c }} className="font-semibold">over 90 Concern</span>.
          {clipped.length > 0 && ` ${clipped.join(", ")} ${clipped.length > 1 ? "run" : "runs"} off the scale (›).`}
          {noCycle.length > 0 && ` No turnover days for ${bucket}: ${noCycle.join(", ")}.`}
        </p>
      </Card>
    </div>
  );
}
