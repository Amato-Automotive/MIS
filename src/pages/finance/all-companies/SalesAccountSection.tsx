// §1 Sales Accounts across companies — how much each company sells, and
// through which channel. One chart (size or mix, by the ₹ / % switch) and the
// exact figures beneath it.
//
// Channels come from each company's own sheet rows (the lines above its Sales
// Total), so a channel one company lacks is absent for it — shown as "—", never
// as a zero sale.
import { useMemo, useState } from "react";
import { Card, ValueModeToggle, bucketLabelsOf, bucketValue, type ValueMode } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { NEUTRAL_COLOR } from "../format";
import ChartLegend from "../shared/ChartLegend";
import {
  BarRow, CompanyTd, MoneyTd, PeriodEmpty, TableCard, Th, TipBox, fmtMoney, pctOf, rowBg,
  type ConsolidatedCompany,
} from "./shared";

// The slice for a period the sheet gives a Sales total for but no channel split
// (some yearly columns) — drawn as its own neutral slice rather than a bar that
// stops short of the total.
const UNSPLIT = "__unsplit";
const UNSPLIT_LABEL = "Not broken down";

// The finance palette, reordered so the third channel — External Sales, nearly
// every company's bulk — takes the calm steel blue rather than heavy bronze;
// the smaller channels carry the warmer accents.
const CHANNEL_PALETTE = ["#B65A3A", "#8B6A45", "#4E6575", "#738A5A", "#3A4E5C", "#96492E"];

interface SalesRow {
  id: string;
  label: string;
  total: number | null;
  byKey: Map<string, number | null>;
  unsplit: number | null;
}

export default function SalesAccountSection({ companies, view, bucket, onJump }:
  { companies: ConsolidatedCompany[]; view: TrendView; bucket: string; onJump: (label: string) => void }) {
  const [mode, setMode] = useState<ValueMode>("amount");

  // Every channel any company reports, in the sheet's own row order.
  const channels = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; item_no: number }>();
    for (const c of companies) {
      for (const ch of c.sales_channels) {
        const prev = seen.get(ch.key);
        seen.set(ch.key, { key: ch.key, label: prev?.label ?? ch.label, item_no: Math.min(ch.item_no, prev?.item_no ?? Infinity) });
      }
    }
    return [...seen.values()].sort((a, b) => a.item_no - b.item_no);
  }, [companies]);
  const colors = useMemo(
    () => new Map(channels.map((ch, i) => [ch.key, CHANNEL_PALETTE[i % CHANNEL_PALETTE.length]])),
    [channels]
  );

  const rows: SalesRow[] = useMemo(() => companies.map((c) => {
    const total = bucketValue(c.sales_total, "flow", view, bucket);
    const byKey = new Map(c.sales_channels.map((ch) => [ch.key, bucketValue(ch.series, "flow", view, bucket)] as const));
    const split = [...byKey.values()].reduce<number>((s, v) => s + (v ?? 0), 0);
    const unsplit = total != null && Math.abs(total - split) > Math.abs(total) * 0.005 ? total - split : null;
    return { id: c.id, label: c.label, total, byKey, unsplit };
  }), [companies, view, bucket]);

  const latest = useMemo(() => {
    const labels = bucketLabelsOf(companies.flatMap((c) => c.sales_total), "flow", view);
    return labels[labels.length - 1] ?? null;
  }, [companies, view]);

  // Largest first: the chart answers "who sells most, and how".
  const ranked = useMemo(() => rows
    .filter((r): r is SalesRow & { total: number } => r.total != null && r.total > 0)
    .sort((a, b) => b.total - a.total), [rows]);
  const maxTotal = ranked[0]?.total ?? 0;
  const anyUnsplit = rows.some((r) => r.unsplit != null && r.unsplit > 0);

  if (rows.every((r) => r.total == null && [...r.byKey.values()].every((v) => v == null))) {
    return <PeriodEmpty what="sales figures" bucket={bucket} latest={latest} onJump={onJump} />;
  }

  const legend = [
    ...channels.map((ch) => ({ key: ch.key, label: ch.label, color: colors.get(ch.key)! })),
    ...(anyUnsplit ? [{ key: UNSPLIT, label: UNSPLIT_LABEL, color: NEUTRAL_COLOR }] : []),
  ];
  const valueOf = (r: SalesRow, key: string) => (key === UNSPLIT ? r.unsplit : r.byKey.get(key) ?? null);

  return (
    <div className="flex flex-col gap-4">
      <Card title="Sales by company and channel"
        note={mode === "percent"
          ? `${bucket} sales split by channel, as a share of each company's own Sales — compares the mix, whatever the size.`
          : `${bucket} sales split by channel — bar length is the company's Sales. Switch to % to compare the mix.`}
        right={<ValueModeToggle mode={mode} onChange={setMode} />}>
        <div className="flex flex-col gap-3 mt-1">
          {ranked.map((r) => (
            <BarRow key={r.id} name={r.label} value={fmtMoney(r.total)}
              hover={
                <TipBox title={`${r.label} · ${fmtMoney(r.total)}`}>
                  {legend.map((l) => {
                    const v = valueOf(r, l.key);
                    if (v == null) return null;
                    return (
                      <div key={l.key} className="flex items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-gray-600">
                          <span className="w-2 h-2 rounded-sm" style={{ background: l.color }} />{l.label}
                        </span>
                        <span className="tabular-nums text-gray-800">{fmtMoney(v)} · {pctOf(v, r.total) ?? "—"}</span>
                      </div>
                    );
                  })}
                </TipBox>
              }>
              <div className="h-3 rounded-full bg-[#F3EEE4]">
                <div className="h-3 rounded-full overflow-hidden flex"
                  style={{ width: mode === "percent" ? "100%" : `${Math.max(0.5, (r.total / maxTotal) * 100)}%` }}>
                  {legend.map((l) => {
                    // A stack can't draw a negative slice; the few rupees of negative
                    // branch sales some months carry stay exact in the hover card.
                    const v = Math.max(0, valueOf(r, l.key) ?? 0);
                    return v > 0 ? <div key={l.key} style={{ width: `${(v / r.total) * 100}%`, background: l.color }} /> : null;
                  })}
                </div>
              </div>
            </BarRow>
          ))}
        </div>
        <ChartLegend items={legend} />
      </Card>

      <TableCard footer={
        <>Share = the channel ÷ the company's Sales for {bucket}, from §1 Sales Accounts (Branch Purchase sits below its Total
          and is not a sale). "—" = no such line, or no figure for the period.</>
      }>
        <thead>
          <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
            <Th align="left">Company</Th>
            <Th>Sales</Th>
            {channels.map((ch) => <Th key={ch.key}>{ch.label}</Th>)}
            {anyUnsplit && <Th>{UNSPLIT_LABEL}</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={rowBg(i)}>
              <CompanyTd label={r.label} />
              <MoneyTd value={r.total} />
              {channels.map((ch) => {
                const v = r.byKey.get(ch.key) ?? null;
                return <MoneyTd key={ch.key} value={v} sub={pctOf(v, r.total)} />;
              })}
              {anyUnsplit && <MoneyTd value={r.unsplit} sub={pctOf(r.unsplit, r.total)} />}
            </tr>
          ))}
        </tbody>
      </TableCard>
    </div>
  );
}
