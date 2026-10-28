// §6 Key Ratios across companies — one row per ratio, one column per company,
// each cell shaded against the same benchmark the company tabs use. Reading
// along a row compares companies; reading down a column is one company's health.
//
// Every cell goes through ratioReading, the same function the company tabs use,
// so a quarter or a year here is worked out exactly as it is there.
import { useMemo, type ReactNode } from "react";
import {
  RAG, RatioDerivationNote, bucketLabelsOf, formatRatio, ratioReading, ratioTarget, ratioVerdict,
  type RatioItem,
} from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { PeriodEmpty, Th, type ConsolidatedCompany } from "./shared";

const slugOf = (lineKey: string) => lineKey.slice(lineKey.lastIndexOf("/") + 1);

export default function RatioScorecard({ companies, view, bucket, onJump }:
  { companies: ConsolidatedCompany[]; view: TrendView; bucket: string; onJump: (label: string) => void }) {
  // Rows: every ratio any company reports, grouped by category in the sheet's
  // order. Matched across companies by category + slug, since a label can carry
  // a stray "%" on one tab and not the next.
  const groups = useMemo(() => {
    const cats = new Map<string, { label: string; rows: Map<string, { slug: string; label: string; lineKey: string }> }>();
    for (const c of companies) {
      for (const cat of c.ratios ?? []) {
        if (!cats.has(cat.label)) cats.set(cat.label, { label: cat.label, rows: new Map() });
        const g = cats.get(cat.label)!;
        for (const it of cat.items) {
          const slug = slugOf(it.line_key);
          // The sheet labels the cash cycle just "Net".
          const label = slug === "net" ? "Net (cash cycle)" : it.line_label.replace(/\s*%\s*$/, "").trim();
          if (!g.rows.has(slug)) g.rows.set(slug, { slug, label, lineKey: it.line_key });
        }
      }
    }
    return [...cats.values()].map((g) => ({ label: g.label, rows: [...g.rows.values()] }));
  }, [companies]);

  const itemIndex = useMemo(() => companies.map((c) => {
    const m = new Map<string, RatioItem>();
    for (const cat of c.ratios ?? []) for (const it of cat.items) m.set(`${cat.label}|${slugOf(it.line_key)}`, it);
    return m;
  }), [companies]);

  const allCats = useMemo(() => companies.flatMap((c) => c.ratios ?? []), [companies]);
  const latest = useMemo(() => {
    const labels = bucketLabelsOf(allCats.flatMap((cat) => cat.items.flatMap((it) => it.series)), "stock", view);
    return labels[labels.length - 1] ?? null;
  }, [allCats, view]);

  const cells = useMemo(() => groups.map((g) => g.rows.map((row) => companies.map((_, ci) => {
    const it = itemIndex[ci].get(`${g.label}|${row.slug}`);
    if (!it) return null;
    const reading = ratioReading(it, view, bucket);
    return { it, ...reading, verdict: reading.value != null ? ratioVerdict(it.line_key, reading.value) : null };
  }))), [groups, companies, itemIndex, view, bucket]);

  if (groups.length === 0 || cells.every((g) => g.every((r) => r.every((c) => c?.value == null)))) {
    return <PeriodEmpty what="ratios" bucket={bucket} latest={latest} onJump={onJump} />;
  }

  return (
    <div className="bg-white border border-[#EAE3D6] rounded-2xl overflow-hidden">
      <div className="px-4 pt-4">
        <p className="text-[11px] leading-relaxed text-gray-500 mb-3">
          Each cell is that company's ratio for {bucket}, shaded against the benchmark the company tabs use —{" "}
          <span className="font-semibold" style={{ color: RAG.good.c }}>Healthy</span>,{" "}
          <span className="font-semibold" style={{ color: RAG.warn.c }}>Watch</span> or{" "}
          <span className="font-semibold" style={{ color: RAG.bad.c }}>Concern</span>; unshaded ratios have no benchmark.
          "—" means no figure for the period. Columns are the sheet's tab names — hover one for the company, or a cell for how it
          was worked out.
        </p>
        <RatioDerivationNote cats={allCats} view={view} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-y border-[#EAE3D6] bg-[#FAF7F1]">
              <Th align="left" className="sticky left-0 bg-[#FAF7F1] z-10">Ratio</Th>
              <Th align="left">Target</Th>
              {/* Full display names can't head a column — the sheet tab's own short
                  name does, with the full name on hover. */}
              {companies.map((c) => (
                <th key={c.id} title={c.label}
                  className="px-3 py-3 text-[10px] font-bold uppercase tracking-wider text-gray-600 text-right whitespace-nowrap">
                  {c.short_label || c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => (
              <GroupRows key={g.label} label={g.label} span={companies.length + 2}>
                {g.rows.map((row, ri) => (
                  <tr key={row.slug} className="border-b border-[#F3EEE4]">
                    <td className="sticky left-0 z-10 bg-white px-4 py-2 text-[12px] font-semibold text-gray-700 whitespace-nowrap">{row.label}</td>
                    <td className="px-4 py-2 text-[11px] text-gray-500 whitespace-nowrap">{ratioTarget(row.lineKey)?.replace("Target ", "") ?? ""}</td>
                    {cells[gi][ri].map((cell, ci) => (
                      <td key={companies[ci].id}
                        className="px-3 py-2 text-right text-[12px] font-semibold tabular-nums whitespace-nowrap"
                        style={cell?.verdict ? { background: RAG[cell.verdict.status].bg } : undefined}
                        title={cell ? [cell.verdict && RAG[cell.verdict.status].t, cell.basis].filter(Boolean).join(" · ") || undefined : undefined}>
                        {cell?.value != null
                          ? <span className="text-gray-800">{formatRatio(cell.it.line_label, cell.value, cell.it.line_key)}</span>
                          : <span className="text-gray-400 font-medium">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </GroupRows>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ label, span, children }: { label: string; span: number; children: ReactNode }) {
  return (
    <>
      <tr className="bg-[#FCFBF8]">
        <td colSpan={span} className="sticky left-0 px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</td>
      </tr>
      {children}
    </>
  );
}
