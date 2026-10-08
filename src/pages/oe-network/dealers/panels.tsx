import { VISIT_COLOR, NEUTRAL_BAR, OVER_COLOR, ON_TRACK_PCT, firstName, coverageColor, MONTH_SHORT } from "../shared";
import {
  type DealerSpRow, type DealerQuarter, type DealerPerf, n0, pct, categoryLabel,
  oursLabels,
} from "./model";
import Explain from "./Explain";

/** Coverage per rep: how much of the patch they actually touched. */
export function CoveragePanel({ rows }: { rows: DealerSpRow[] }) {
  const real = rows.filter((r) => r.salesperson !== "Unassigned");
  const max = Math.max(...real.map((r) => r.assigned), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Coverage</h3>
      <Explain>
        How much of a rep's patch they actually reached in this period: dealerships
        contacted at least once, out of every dealership assigned to them in the OEM's
        own dealer list. Bar length is the size of the patch, fill is the share
        covered — so a short full bar is a small patch worked thoroughly, and a long
        empty one is a big patch going untouched. A visit and a phone call both count.
      </Explain>
      <div className="flex flex-col gap-2.5">
        {[...real].sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0)).map((r) => (
          <div key={r.salesperson} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs font-semibold text-gray-700 truncate">
              {firstName(r.salesperson)}
            </span>
            <div className="flex-1 h-6 rounded-lg bg-gray-100 relative overflow-hidden"
              style={{ maxWidth: `${(r.assigned / max) * 100}%` }}>
              <div className="h-full rounded-lg transition-all"
                style={{ width: `${r.coverage ?? 0}%`, background: VISIT_COLOR, opacity: 0.85 }} />
              {/* White only works while the orange fill reaches the label; on a
                  near-empty bar the label sits on the pale track and has to go
                  dark instead. */}
              <span className={`absolute inset-y-0 left-2 flex items-center text-[10px] font-bold ${
                (r.coverage ?? 0) >= 20 ? "text-white" : "text-gray-500"}`}>
                {r.contacted}
              </span>
            </div>
            <span className={`w-28 shrink-0 text-[11px] font-bold tabular-nums ${coverageColor(r.coverage)}`}>
              {pct(r.coverage)} <span className="text-gray-500 font-medium">of {r.assigned}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Quarter vs quarter: target, achievement, and what actually sold.
 *
 *  Handles both file shapes without the caller having to care which it has.
 *  Where the OEM publishes a quarter achievement column, that is the figure;
 *  where it publishes only monthly results (TATA), `sold` — our units inside
 *  the quarter's own months — stands in, and the panel says so. The two are the
 *  same quantity counted the same way, but only one of them was stated by the
 *  team, so they are never silently interchanged.
 *
 *  `by_product` splits the bars where an OEM sets a target per product. It is
 *  drawn only when there is genuinely more than one — a single "Seat Covers"
 *  sub-row under an identical total is noise. */
export function QuarterPanel({ rows, funnel, oems = [] }: {
  rows: DealerQuarter[]; funnel: boolean;
  /** See DealerTrend: aggregated rows carry no OEM, so the vocabulary comes
   *  in beside them. */
  oems?: string[];
}) {
  const L = oursLabels(oems);
  if (!rows.length) return null;
  const achOf = (r: DealerQuarter) => r.achievement ?? r.sold ?? 0;
  const max = Math.max(...rows.flatMap((r) => [r.target ?? 0, achOf(r), r.ys_sale ?? 0]), 1);
  const derived = rows.some((r) => r.achievement == null && r.sold != null);
  const split = rows.some((r) => r.by_product.length > 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Quarter vs quarter</h3>
      <Explain>
        Units targeted against units achieved, per quarter, for the dealerships in
        view. A quarter appears whenever the period touches it at all and its target
        is always shown <b className="text-gray-600">whole</b> — targets are agreed per
        quarter, so cutting one into part-months would invent a number nobody set.
        A quarter still in progress therefore reads under 100% by design; read the
        share against how much of the quarter has actually gone.
        {derived && (
          <> This OEM's file publishes no quarter achievement column, so{" "}
            <b className="text-gray-600">Achieved</b> is summed from the months inside
            the quarter, up to the end of the selected period — our own sales, counted
            the same way, but derived here rather than stated by the team.</>
        )}
        {split && <> Each quarter is split by product, since the targets are set that way.</>}
      </Explain>
      <div className="flex flex-col gap-4">
        {rows.map((r) => {
          const ach = achOf(r);
          const tgt = r.target ?? 0;
          const hit = tgt ? Math.round((ach / tgt) * 100) : null;
          return (
            <div key={`${r.fy_year}${r.quarter}`}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs font-bold text-gray-700">
                  {r.label}
                  {/* Quarter to date, so the bar matches the tiles above. */}
                  {r.achievement == null && r.sold_through && r.sold_through < r.period_end && (
                    <span className="ml-1.5 font-normal text-gray-500">
                      achieved to {MONTH_SHORT[Number(r.sold_through.slice(5, 7)) - 1]}
                    </span>
                  )}
                </span>
                {/* Only the funnel OEMs can say how big the quarter was; for the
                    rest there is no total to report and the line stays off
                    rather than printing a zero. */}
                {funnel && (
                  <span className="text-[11px] text-gray-500">
                    {r.ysasc == null ? n0(r.oem_total) + " sold" : `${n0(r.ysasc)} ${L.avail}`}
                    {" · "}{pct(r.penetration)} {L.share}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Target</span>
                <div className="flex-1 h-4 rounded bg-gray-100">
                  <div className="h-full rounded" style={{ width: `${(tgt / max) * 100}%`, background: NEUTRAL_BAR }} />
                </div>
                <span className="w-16 text-right text-[11px] font-semibold tabular-nums text-gray-500">{n0(tgt)}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Achieved</span>
                <div className="flex-1 h-4 rounded bg-gray-100">
                  <div className="h-full rounded transition-all" style={{
                    width: `${(ach / max) * 100}%`,
                    background: hit !== null && hit >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                  }} />
                </div>
                <span className="w-16 text-right text-[11px] font-bold tabular-nums text-gray-700">
                  {ach ? n0(ach) : "—"}
                </span>
              </div>
              {hit !== null && (
                // Same spacer as the bar rows above, so the footnote aligns with
                // the tracks without a hand-tuned padding value.
                <div className="flex gap-2 mt-1">
                  <span className="w-16 shrink-0" />
                  <p className="text-[10px] text-gray-500">
                    {ach ? `${hit}% of target` : "quarter still open"}
                  </p>
                </div>
              )}
              {r.by_product.length > 1 && (
                <div className="flex gap-2 mt-1.5">
                  <span className="w-16 shrink-0" />
                  <div className="flex-1 flex flex-col gap-1">
                    {r.by_product.map((b) => {
                      const bAch = b.achievement ?? b.sold ?? 0;
                      const bHit = b.target ? Math.round((bAch / b.target) * 100) : null;
                      return (
                        <div key={b.product} className="flex items-center gap-2 text-[10px]">
                          <span className="w-20 shrink-0 text-gray-500">{categoryLabel(b.product)}</span>
                          <div className="flex-1 h-2 rounded bg-gray-100">
                            <div className="h-full rounded" style={{
                              width: `${Math.min(bHit ?? 0, 100)}%`,
                              background: bHit !== null && bHit >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                              opacity: 0.75,
                            }} />
                          </div>
                          <span className="w-28 text-right tabular-nums text-gray-500">
                            {n0(bAch)} / {n0(b.target)}
                            {bHit !== null && <b className="ml-1 text-gray-700">{bHit}%</b>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Does contacting a dealer more actually move what we sell there? */
export function ContactEffectPanel({ data, oems = [] }: {
  data: DealerPerf["contact_effect"]; oems?: string[];
}) {
  const L = oursLabels(oems);
  if (!data.buckets.length) return null;
  const max = Math.max(...data.buckets.map((b) => b.penetration ?? 0), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Does contacting them help?</h3>
      <Explain>
        Dealerships grouped by how many times they were contacted in a month, and what
        our {L.share} was at them <b className="text-gray-600">in that same month</b>.
        Each bar is a group, not a dealer — "3-4" means every dealer-month with three
        or four contacts in it. If contact moved the needle, the bars would climb left
        to right.
      </Explain>
      <div className="flex items-end gap-3 h-40">
        {data.buckets.map((b) => (
          <div key={b.bucket} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
            <span className="text-[11px] font-bold text-gray-700">{pct(b.penetration)}</span>
            <div className="w-full rounded-t-lg transition-all" style={{
              height: `${((b.penetration ?? 0) / max) * 100}%`,
              background: VISIT_COLOR,
              opacity: 0.35 + 0.65 * ((b.penetration ?? 0) / max),
            }} />
            <span className="text-[10px] font-semibold text-gray-500">{b.bucket}</span>
            <span className="text-[9px] text-gray-500">{b.dealer_months} mo</span>
          </div>
        ))}
      </div>
    </div>
  );
}
