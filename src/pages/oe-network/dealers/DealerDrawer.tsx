import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X, CarFront, Package, Target, Footprints, Percent } from "lucide-react";
import {
  API_URL, StatCard, ModeBadge, shortDate, MONTH_SHORT,
  ON_TRACK_PCT, OVER_COLOR, VISIT_COLOR,
} from "../shared";
import { type DealerDetail, KPI, n0, nOr, pct, hitPct, categoryLabel, totalLabel, oursLabels } from "./model";
import DealerTrend from "./DealerTrend";

/** "Aug 2026" for a single month, "Apr – Jun 2026" for a range. Sales are
 *  monthly, so the label names months even when a custom day range was picked —
 *  claiming day precision the figures don't have would be the same lie the
 *  tab's own note warns about. */
function periodLabel(p: DealerDetail["period"]): string {
  if (!p.month_from || !p.month_to) return "Selected period";
  const [y1, m1] = p.month_from.split("-").map(Number);
  const [y2, m2] = p.month_to.split("-").map(Number);
  const a = `${MONTH_SHORT[m1 - 1]} ${y1}`;
  const b = `${MONTH_SHORT[m2 - 1]} ${y2}`;
  return a === b ? a : `${a} – ${b}`;
}

/** Everything about one dealership, opened from any row or dot. */
export default function DealerDrawer({ dealerId, headers, benchmark, periodQuery, onClose }: {
  dealerId: string; headers: Record<string, string>;
  /** The OEM average, carried in from the tab so a single dealer's chart is
   *  read against the same yardstick as everything else on the page. */
  benchmark?: number | null;
  /** The tab's period, so the headline totals cover the same window as the row
   *  this was opened from. */
  periodQuery?: Record<string, string>;
  onClose: () => void;
}) {
  const [data, setData] = useState<DealerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // The trend follows the tab's period like everything else here. "All time" is
  // one click away rather than the default, because a chart that silently
  // ignores the filter reads as broken — but the surrounding history is still
  // what makes a single month mean anything, so it stays reachable.
  const [scope, setScope] = useState<"period" | "all">("period");
  const q = new URLSearchParams(periodQuery ?? {}).toString();

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `${API_URL}/oe-network/dealer-performance/${dealerId}${q ? `?${q}` : ""}`,
          { headers, signal: ctrl.signal });
        if (res.ok) setData(await res.json());
        setLoading(false);
      } catch { /* aborted — the drawer is gone or showing another dealer */ }
    })();
    return () => ctrl.abort();
  }, [dealerId, headers, q]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  // The page must not scroll behind the drawer.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const d = data?.dealer;

  /**
   * ONE scope for the whole drawer. Everything below — tiles, trend, quarter
   * targets, contact log — is cut to the same window, so no two panels can
   * disagree about what "this dealer" means. The payload always arrives whole,
   * so switching costs no request.
   *
   * Dates are ISO strings throughout, which compare as dates.
   */
  const view = useMemo(() => {
    if (!data) return null;
    const { month_from: lo, month_to: hi, date_from: dLo, date_to: dHi, all_time } = data.period;
    const whole = all_time || scope === "all";
    return {
      whole,
      totals: whole ? data.lifetime : data.totals,
      months: whole ? data.by_month
        : data.by_month.filter((m) => (!lo || m.month >= lo) && (!hi || m.month <= hi)),
      // A quarter counts if it OVERLAPS the period at all, and its target is
      // shown whole — slicing one would invent a number nobody agreed to.
      // `sold` becomes quarter to date, matching the tab's Achieved % for the
      // same period; All time keeps every quarter whole.
      targets: whole ? data.targets
        : data.targets.filter((t) =>
          (!lo || t.period_end >= lo) && (!hi || t.period_start <= hi))
          .map((t) => ({ ...t, sold: t.sold_to_period })),
      history: whole ? data.history
        : data.history.filter((h) => h.visit_date
          && (!dLo || h.visit_date >= dLo) && (!dHi || h.visit_date <= dHi)),
    };
  }, [data, scope]);

  // Whether this dealer's OEM publishes the funnel. Defaults true so the drawer
  // opens in its familiar shape while the first response is in flight, matching
  // the tab's default for the same reason.
  const funnel = data?.capabilities?.funnel ?? true;

  // The drawer is one dealer, so the OEM is unambiguous and our units get
  // that OEM's own name for them — YS on MSIL, Amato on TATA.
  const L = oursLabels(data ? [data.dealer.oem] : []);

  // Target and achievement rolled up across the quarters in scope, for the
  // non-funnel tile set. Summed from the SAME rows the Target vs achievement
  // panel lists further down, so the headline and the breakdown cannot
  // disagree; `sold` falls back to the months' own sum because TATA publishes
  // no quarter achievement column.
  const tgtTotals = useMemo(() => {
    const rows = view?.targets ?? [];
    return {
      target: rows.reduce((a, t) => a + (t.target ?? 0), 0),
      sold: rows.reduce((a, t) => a + (t.achievement ?? t.sold ?? 0), 0),
    };
  }, [view]);

  // The featured remark comes from whatever is in scope — quoting a note from
  // outside the selected period under period figures is the same mismatch in
  // miniature. History arrives newest-first, so the first match is the latest.
  const lastNote = useMemo(
    () => view?.history.find((h) => h.contact_mode === "Visit" && h.notes.length > 0) ?? null,
    [view],
  );
  // Only label the product lines where this dealer actually buys more than one;
  // a lone "Seat Covers" column beside every quarter is noise.
  const multiProduct = (data?.by_product.length ?? 0) > 1;
  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="absolute inset-0 bg-gray-900/30 backdrop-blur-[2px]" onClick={onClose}
      />
      <motion.div
        initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.18 }}
        role="dialog" aria-modal="true" aria-label={d?.name ?? "Dealer details"}
        // ~72% of the viewport on a monitor rather than a fixed 672px slice —
        // the KPI row was truncating every label ("TO…", "PE…") and the charts
        // were working in half the room the screen actually had.
        className="relative w-full lg:w-[72vw] max-w-6xl h-full bg-gray-50 overflow-y-auto shadow-2xl"
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-orange-100 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-gray-900 truncate">{d?.name ?? "Loading…"}</h2>
            {d && (
              <>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {d.city} · {d.state} · {d.oem} · handled by <b className="text-gray-600">{d.salesperson ?? "—"}</b>
                </p>
              </>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 text-gray-500 hover:text-gray-700 p-1">
            <X size={18} />
          </button>
        </div>

        {loading && <div className="p-10 text-center text-sm text-gray-500">Loading…</div>}

        {data && view && (
          <div className="p-5 flex flex-col gap-4">
            {/* One control for the whole drawer. Everything below is cut to
                this window, so the drawer can never appear to disagree with the
                row it was opened from — that mismatch is what made lifetime
                figures under a monthly row look like a bug. */}
            <div className="flex items-center justify-between flex-wrap gap-2 -mb-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Showing {view.whole ? "all time" : periodLabel(data.period)}
                {!view.whole && (
                  <span className="ml-2 font-medium normal-case tracking-normal text-gray-500">
                    · lifetime {n0(data.lifetime.ys_sale)} ours
                    {data.lifetime.oem_total != null && <> of {n0(data.lifetime.oem_total)} sold</>}
                    {" "}across {data.lifetime.months} month{data.lifetime.months === 1 ? "" : "s"}
                  </span>
                )}
              </p>
              {!data.period.all_time && (
                <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5 shrink-0">
                  {([["period", periodLabel(data.period)], ["all", "All time"]] as const).map(
                    ([k, label]) => (
                      <button key={k} onClick={() => setScope(k)}
                        className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
                          scope === k ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
                        }`}>
                        {label}
                      </button>
                    ))}
                </div>
              )}
            </div>

            {/* Same colour identities as the tab's KPI row — see KPI in model.ts.
                3 columns until the drawer is genuinely wide: five abreast in a
                narrow drawer is what truncated every label to "TO…" / "PE…".
                The drawer is 72vw, so five funnel tiles only fit at 2xl — the
                funnel names are the long ones and they are the reason the
                breakpoint differs between the two sets.

                Two tile sets, chosen by what the OEM publishes — not one set
                with dashes in it. TATA reports a target and what we sold
                against it and never how much the dealer sold in total, so
                a total, an addressable figure and a share have no answer
                for a dealer whose OEM publishes none of them, in any month.
                (TATA now publishes a seat-cover total, so this applies to its mat
                figures rather than to the whole tab.) Drawn anyway they
                were three permanently empty tiles that read as a load failure. */}
            <div className={`grid grid-cols-2 md:grid-cols-3 gap-3 ${
              funnel ? "2xl:grid-cols-5" : "xl:grid-cols-4"}`}>
              {funnel ? (
                <>
                  {/* Within a funnel OEM a single dash still means "not
                      published for this month", which is a different statement
                      from zero — see Funnel in model.ts. */}
                  <StatCard label={totalLabel([data.dealer.oem])} value={nOr(view.totals.oem_total)}
                    sub={view.totals.oem_total == null ? "not reported for this period" : undefined}
                    icon={<CarFront size={16} />} {...KPI.neutral} />
                  <StatCard label={L.avail} value={nOr(view.totals.ysasc)}
                    sub={view.totals.ysasc == null
                      ? "not supplied"
                      : `${pct(view.totals.addressable_pct)} of ${nOr(view.totals.oem_total)}`}
                    icon={<Package size={16} />} {...KPI.neutral} />
                  <StatCard label={L.sale} value={n0(view.totals.ys_sale)} icon={<Package size={16} />}
                    {...KPI.ours} />
                  <StatCard label={L.share} value={pct(view.totals.penetration)}
                    sub={view.totals.penetration == null
                      ? "not supplied"
                      : `${n0(view.totals.ys_sale)} ÷ ${nOr(view.totals.ysasc)}`}
                    icon={<Target size={16} />} {...KPI.conversion} />
                </>
              ) : (
                <>
                  {/* Purple is `target` and never lands on a person — see KPI.
                      Quarterly and never pro-rated, matching the tab and the
                      Target vs achievement panel below, so the three cannot
                      disagree. */}
                  <StatCard label="Target" value={n0(tgtTotals.target)}
                    sub={view.whole ? "every quarter on record" : "quarter target, not pro-rated"}
                    icon={<Target size={16} />} {...KPI.target} />
                  <StatCard label={L.sale} value={n0(tgtTotals.sold)}
                    sub={view.whole ? "our units inside those quarters" : "quarter to date"}
                    icon={<Package size={16} />} {...KPI.ours} />
                  {/* A percentage, so it is named as one — this tile read
                      "vs Target" while showing achieved ÷ target, the same
                      mislabel the directory column carried. */}
                  <StatCard label="Achieved %" value={pct(hitPct(tgtTotals.sold, tgtTotals.target))}
                    sub={`${n0(tgtTotals.sold)} ÷ ${n0(tgtTotals.target)}`}
                    icon={<Percent size={16} />} {...KPI.conversion} />
                </>
              )}
              <StatCard label="Contacts" value={view.totals.visits + view.totals.calls}
                sub={`${view.totals.visits} visits · ${view.totals.calls} calls`}
                icon={<Footprints size={16} />} {...KPI.activity} />
            </div>

            {lastNote && (
              <div className="bg-white border border-orange-200 rounded-2xl p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-brand-orange mb-1">
                  Last field visit remark · {shortDate(lastNote.visit_date)} ·{" "}
                  {lastNote.salesperson}
                </p>
                {lastNote.notes.map((nt, i) => (
                  <p key={i} className="text-sm text-gray-700 leading-relaxed">
                    <span className="text-[10px] font-bold uppercase text-gray-500 mr-1.5">{nt.label}</span>
                    {nt.text}
                  </p>
                ))}
              </div>
            )}

            {view.months.length > 0 ? (
              <DealerTrend rows={view.months} benchmark={benchmark} oems={[data.dealer.oem]}
                title={`This dealership, month by month${view.whole ? " — all time" : ""}`}
                subject="this dealership" />
            ) : (
              // The period genuinely holds no month for this dealer. Saying so
              // beats an empty card that looks like a failed render.
              <div className="bg-white border border-orange-100 rounded-2xl p-8 text-center">
                <p className="text-sm text-gray-500">
                  No month of sales for this dealership in {periodLabel(data.period)}.
                </p>
                <button onClick={() => setScope("all")}
                  className="mt-2 text-xs font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                  Show all time instead
                </button>
              </div>
            )}

            {view.targets.length > 0 && (
              <div className="bg-white border border-orange-100 rounded-2xl p-5">
                <h3 className="text-sm font-bold text-gray-800">Target vs achievement</h3>
                {/* A quarter is kept whenever it overlaps the period and is
                    never pro-rated — the same rule the tab's Quarter panel
                    uses, so the two cannot disagree. */}
                <p className="text-[10px] text-gray-500 mb-2">
                  {view.whole
                    ? "Every quarter on record"
                    : `Quarters touching ${periodLabel(data.period)} — each target shown whole`}
                  {view.targets.some((t) => t.achievement == null && t.sold != null)
                    && " · achieved is summed from the quarter's months, this OEM publishes no quarter total"}
                </p>
                <div className="flex flex-col gap-2">
                  {view.targets.map((t) => {
                    // `sold` stands in where the OEM publishes no quarter
                    // achievement column — our units inside the quarter's own
                    // months, the same quantity counted the same way.
                    const ach = t.achievement ?? t.sold ?? 0;
                    const hit = t.target ? Math.round((ach / t.target) * 100) : null;
                    return (
                      <div key={`${t.label}-${t.product}`} className="flex items-center gap-3 text-xs">
                        <span className="w-16 font-bold text-gray-700">{t.label}</span>
                        {multiProduct && (
                          <span className="w-20 shrink-0 text-[10px] text-gray-500">
                            {categoryLabel(t.product)}
                          </span>
                        )}
                        <div className="flex-1 h-4 rounded bg-gray-100 relative">
                          <div className="h-full rounded" style={{
                            width: `${Math.min(hit ?? 0, 100)}%`,
                            background: hit !== null && hit >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                          }} />
                        </div>
                        <span className="w-32 text-right tabular-nums text-gray-500">
                          {n0(ach)} / {n0(t.target)}
                          {hit !== null && <b className="ml-1 text-gray-700">{hit}%</b>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bg-white border border-orange-100 rounded-2xl p-5">
              <h3 className="text-sm font-bold text-gray-800">
                Contact history <span className="text-gray-500 font-medium">({view.history.length})</span>
              </h3>
              <p className="text-[10px] text-gray-500 mb-1">
                {view.whole
                  ? "Every contact on record"
                  : `Contacts in ${periodLabel(data.period)} · ${data.history.length} on record in total`}
              </p>
              {view.history.length === 0 && (
                <p className="text-sm text-gray-500 py-4 text-center">
                  {data.history.length === 0
                    ? "No contact logged with this dealership yet."
                    : `No contact in ${periodLabel(data.period)} — ${data.history.length} logged outside it.`}
                </p>
              )}
              <div className="flex flex-col divide-y divide-gray-50">
                {view.history.map((h) => (
                  <div key={h.id} className="py-3 flex gap-3">
                    <div className="w-14 shrink-0">
                      <p className="text-[11px] font-bold text-gray-600">{shortDate(h.visit_date)}</p>
                      <ModeBadge mode={h.contact_mode} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-gray-500">
                        {h.salesperson}
                        {h.contact_person && ` · met ${h.contact_person}`}
                        {h.designation && ` (${h.designation})`}
                        {h.channel && ` · ${h.channel}`}
                      </p>
                      {h.notes.length === 0 && <p className="text-xs text-gray-500 italic">no remark</p>}
                      {h.notes.map((nt, i) => (
                        <p key={i} className="text-xs text-gray-700 mt-0.5 leading-relaxed">
                          <span className="text-[9px] font-bold uppercase text-gray-500 mr-1">{nt.label}</span>
                          {nt.text}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
