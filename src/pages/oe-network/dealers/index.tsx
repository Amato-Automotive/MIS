import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Store, Target, CarFront, Percent, Package, Barcode } from "lucide-react";
import Select from "@/components/ui/Select";
import {
  API_URL, MONTH_SHORT, FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, SyncButton, useSyncLatest, PeriodControls, StatCard,
  periodParams, usePeriod, useFilterOptions, filterOpts, FILTER_LABELS,
  shortDate, useOEScope, ScopeNote, type Period,
} from "../shared";
import { type DealerPerf, KPI, n0, nOr, pct, hitPct, categoryLabel, totalLabel, oursLabels } from "./model";
import Explain from "./Explain";
import DealerMap from "./DealerMap";
import DealerRankTable from "./DealerRankTable";
import DealerDirectory from "./DealerDirectory";
import DealerTrend from "./DealerTrend";
import DealerDrawer from "./DealerDrawer";
import { CoveragePanel, QuarterPanel, ContactEffectPanel } from "./panels";

export default function DealersTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson: scopeName } = useOEScope();
  // dealer_sales, not logs: this tab can only show OEMs we hold a dealer
  // sales file for, so the filter offers exactly those and grows by itself.
  const options = useFilterOptions<{
    oems: string[]; states: string[]; salespersons: string[]; products: string[];
  }>("dealer_sales", headers);
  // The tab opens on ONE OEM on purpose. Unfiltered, seat-cover volumes from
  // every OEM sum into one share, and the OEMs are not comparable that way —
  // MSIL converts about 15% of what it can and TATA about 75%, so the blend
  // describes neither. MSIL is the default only because it is the file we
  // have carried longest; it is a normal filter value and Clear resets it.
  const [oem, setOem] = useState("MSIL");
  const [salesperson, setSalesperson] = useState("");
  const [state, setState] = useState("");
  // Product exists because the OEMs disagree: MSIL's file is seat covers only,
  // TATA's sets a separate target for seat covers and for mats. Unfiltered means
  // every product summed, which is the whole picture for either.
  const [product, setProduct] = useState("");
  // Monthly, like every other tab. It lands on the newest month the dealer
  // FILE actually covers, not the current calendar month — dealer sales run
  // ahead of or behind the log book, so "this month" could be a month with no
  // sales in it at all.
  const period = usePeriod("monthly");
  const [data, setData] = useState<DealerPerf | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDealer, setOpenDealer] = useState<string | null>(null);
  // Bumped by Refresh — re-runs the fetch without changing any filter.
  const [refreshKey, setRefreshKey] = useState(0);
  // The log book too: each dealership's visit history and contact effect
  // come from it, not from the dealer file.
  const { syncing, syncAll } = useSyncLatest(headers, () => setRefreshKey((n) => n + 1), ["dealers", "log"]);

  // The months the dealer file covers, fetched up front. This cannot come from
  // the dealer-performance response the way it used to: the period picker now
  // defaults to a month, so with no month chosen no request fires at all, and
  // the list would never arrive to choose one from.
  //
  // Re-fetched whenever the OEM changes, because the OEMs cover different
  // months and the union is wrong for each of them: MSIL's file runs Jan-Jul
  // 2026, TATA's starts in July. Unscoped, the TATA view offered six months
  // that could only ever draw an empty screen. A month in this picker is a
  // promise that there is something behind it.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (oem) qs.set("oem", oem);
        if (product) qs.set("product", product);
        const res = await fetch(`${API_URL}/oe-network/periods?${qs}`, { headers, signal: ctrl.signal });
        if (!res.ok) return;
        const j: { dealer_months?: Period[] } = await res.json();
        const months = j.dealer_months ?? [];
        period.setMonths(months);
        // Newest month that actually holds dealer sales.
        const newest = [...months].sort((a, b) => b.year - a.year || b.month - a.month)[0];
        if (!newest) { setLoading(false); return; }   // nothing registered yet
        // Keep the chosen month across an OEM switch when the new OEM also
        // covers it — switching MSIL→TATA in July should stay in July rather
        // than jumping, which reads as the filter having lost its place.
        // Otherwise fall to the newest month the new OEM does cover.
        const stillThere = months.some((m) => `${m.year}-${m.month}` === period.token);
        if (!stillThere) period.setToken(`${newest.year}-${newest.month}`);
      } catch { /* aborted or offline — the picker simply stays empty */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, refreshKey, oem, product]);

  useEffect(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    if (!pp) return;
    const params = new URLSearchParams(pp);
    if (oem) params.set("oem", oem);
    if (salesperson) params.set("salesperson", salesperson);
    if (state) params.set("state", state);
    if (product) params.set("product", product);
    // Aborting the stale request matters here: without it a slow older response
    // can land AFTER a newer one and quietly put yesterday's filter on screen.
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/dealer-performance?${params}`,
          { headers, signal: ctrl.signal });
        if (res.ok) setData(await res.json());
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.mode, period.token, period.range, oem, salesperson, state, product,
      headers, refreshKey]);

  // Reps come from filter-options (the dealer file's own assignment), NOT from
  // this view's by_salesperson rows — those are computed AFTER the rep/state
  // filters apply, so a dropdown built on them collapses to the one rep you
  // just picked and there is no way to switch to another without clearing.
  const reps = options?.salespersons ?? [];

  const k = data?.kpis;
  // What the OEMs in view actually publish. TATA reports a target and what we
  // achieved against it and never how much the dealer sold, so penetration,
  // addressable % and everything read off them are unavailable rather than
  // zero — the panels built on them are not drawn at all, instead of drawing a
  // screen of dashes that looks like a failed load. Defaults true so the tab
  // renders its familiar shape while the first response is in flight.
  const funnel = data?.capabilities.funnel ?? true;
  // TATA carries our full range, so its Available Part Number % is 100 by
  // definition rather than by accident. Said on the tiles, not in a tooltip.
  const fullCoverage = data?.capabilities.full_coverage ?? false;
  // The OEM whose column this is. "Total MSIL SC Sales" over TATA numbers
  // names the wrong OEM, which reads as the filter having failed.
  const fs = data?.funnel_scope ?? null;
  const oems = [...new Set((data?.dealers ?? []).map((d) => d.oem))];
  const oemTotalLabel = totalLabel(oems);
  // MSIL's file calls our units YS, TATA's calls them Amato. See OURS_NAME.
  // Products in the current selection — the headline tiles are summed over all
  // of them, so a seat-cover word on that figure would be a lie whenever mats
  // are in it too.
  const L = oursLabels(oems, data?.capabilities.products);
  // The panel below is narrower: only the products that publish a total.
  const FS = oursLabels(oems, fs?.products);
  const tgtPct = hitPct(k?.sold, k?.target);
  // `sold` is rolled up to the whole quarters the period touches, because it
  // sits beside a target agreed for a quarter and never pro-rated. So it does
  // NOT move between months inside one quarter — July and August of JAS'26
  // give the same figure. The Target tile has always declared that and this
  // one did not, which made the pair read as one tile having stopped following
  // the filter. Only said when the window really is wider than what was asked
  // for; where no quarter overlaps, `sold` is the selected months after all.
  const ym = (s: string | null | undefined) => s?.slice(0, 7);
  const ss = data?.sold_scope ?? null;
  const soldSub = ss && (ym(ss.month_from) !== ym(data?.period.month_from)
                         || ym(ss.month_to) !== ym(data?.period.month_to))
    ? `${MONTH_SHORT[Number(ss.month_from.slice(5, 7)) - 1]}–${
        MONTH_SHORT[Number(ss.month_to.slice(5, 7)) - 1]}, whole quarter`
    : undefined;
  // The benchmark, NOT this view's own penetration. Filtering to a rep must not
  // change the yardstick their dealers are measured against, or a weak
  // territory reads as having the least to gain.
  const avgPene = k?.benchmark ?? k?.penetration ?? 0;
  const noSales = !!data && data.dealers.every((d) => !d.has_sales);

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        {/* Canonical order and vocabulary — person, then OEM, then geography.
            This dropdown said "Rep" while every other tab called the same field
            "Salesperson". */}
        {!scoped && (
          <Select value={salesperson} onChange={setSalesperson}
            options={filterOpts(reps, "salesperson")}
            placeholder={FILTER_LABELS.salesperson.placeholder} />
        )}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={state} onChange={setState} options={filterOpts(options?.states, "state")}
          placeholder={FILTER_LABELS.state.placeholder} />
        {/* Type slot, after geography — the canonical order. Hand-built options
            because the labels differ from the values: the file says "MAT", the
            product is "Mats". Offered only where more than one product exists
            at all, so the OEMs that sell one thing get no dead control. */}
        {(options?.products?.length ?? 0) > 1 && (
          <Select value={product} onChange={setProduct}
            options={[{ value: "", label: FILTER_LABELS.product.all },
              ...(options?.products ?? []).map((c) => ({ value: c, label: categoryLabel(c) }))]}
            placeholder={FILTER_LABELS.product.placeholder} />
        )}
        {/* OEM belongs here too. It starts set, so leaving it out meant the tab
            opened with a filter applied, no Clear button offered, and nothing on
            screen saying a filter was on at all. */}
        <ClearFilters show={!!(oem || salesperson || state || product)}
          onClear={() => { setOem(""); setSalesperson(""); setState(""); setProduct(""); }} />
        {/* A refetch after the first load used to be invisible — old numbers sat
            on screen with nothing saying a newer answer was on its way. */}
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefreshKey((n) => n + 1)} disabled={loading} />
          <SyncButton onClick={syncAll} syncing={syncing}
            title="Re-pull the dealership view file and the log book from Google Sheets" />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      {scoped && scopeName && (
        <ScopeNote salesperson={scopeName}>
          These are the dealers assigned to you in the OE dealer file, including
          any you have not contacted yet — that gap is the point of this tab. A
          dealer the file leaves unassigned is not shown to anyone.
        </ScopeNote>
      )}

      {/* Sales are monthly figures, so a day range can only cut them to whole
          months. Saying so beats letting the numbers imply otherwise. */}
      {period.mode === "custom" && data?.period.date_from && (
        <p className="text-[11px] text-gray-500 -mt-2">
          Visits and calls counted {shortDate(data.period.date_from)}–{shortDate(data.period.date_to)}.
          Dealer sales are reported monthly, so those cover whole months
          ({MONTH_SHORT[Number(data.period.month_from!.slice(5, 7)) - 1]}–
          {MONTH_SHORT[Number(data.period.month_to!.slice(5, 7)) - 1]}).
        </p>
      )}

      {loading && !data && (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
          Loading dealer performance…
        </div>
      )}

      {/* One colour identity per idea, matching the drawer (see KPI in
          model.ts): activity blue, conversion green, ours orange, target
          purple, context grey. Two tile sets, because the two file shapes
          answer different questions — not the same tiles with blanks in them. */}
      {k && funnel && (
        // Three across, so the six tiles fall into two rows that each hold ONE
        // kind of number: the funnel in units on top (every cover they sold →
        // the ones we make a part for → the ones we sold), and the ratios read
        // off it underneath. Six abreast put a percentage between two unit
        // counts and forced every long name to truncate; the rows are the
        // grouping, not just a way to fit them.
        <div className={`grid grid-cols-2 gap-3 ${
          fullCoverage ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
          <StatCard label={oemTotalLabel} value={nOr(k.oem_total)}
            icon={<CarFront size={18} />} {...KPI.neutral} />
          {/* Not drawn at full coverage: for an OEM whose whole range we carry
              this is the total again and the percentage is 100 by definition,
              and two tiles repeating the number above them invite the question
              of why they disagree. The Explain under the panel says it instead. */}
          {!fullCoverage && (
            <StatCard label={L.avail} value={nOr(k.ysasc)}
              sub={k.ysasc == null ? "not supplied" : undefined}
              icon={<Barcode size={18} />} {...KPI.neutral} />
          )}
          <StatCard label={L.sale} value={n0(k.ys_sale)}
            sub={k.target ? `target ${n0(k.target)}` : undefined}
            icon={<Package size={18} />} {...KPI.ours} />

          <StatCard label={L.share} value={pct(k.penetration)}
            sub={k.ysasc == null ? "not supplied"
                 : fullCoverage ? `${n0(k.ys_sale)} ÷ ${nOr(k.oem_total)} — their whole volume`
                 : `${n0(k.ys_sale)} ÷ ${n0(k.ysasc)}`}
            icon={<Target size={18} />} {...KPI.conversion} />
          {!fullCoverage && (
            /* Directly under the two figures it divides, and next to the share
               because the two get confused constantly: this one is what we make
               a part for, not what we sold. */
            <StatCard label="Available Part Number %" value={pct(k.addressable_pct)}
              sub={k.ysasc == null ? "not supplied" : `${n0(k.ysasc)} ÷ ${nOr(k.oem_total)}`}
              icon={<Percent size={18} />} {...KPI.neutral} />
          )}
          <StatCard label="Coverage" value={pct(k.coverage)}
            sub={`${n0(k.contacted)} of ${n0(k.dealers)} dealerships`}
            icon={<Store size={18} />} {...KPI.activity} />
        </div>
      )}

      {k && !funnel && (
        // One row of four. This source publishes a target and what we sold
        // against it — four figures, so four tiles, rather than the funnel
        // set's two rows.
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Purple is `target` and never lands on a person — see KPI. */}
          <StatCard label="Target" value={n0(k.target)}
            sub="whole quarter, never pro-rated"
            icon={<Target size={18} />} {...KPI.target} />
          <StatCard label={L.sale} value={n0(k.sold)} sub={soldSub}
            icon={<Package size={18} />} {...KPI.ours} />
          <StatCard label="Achieved %" value={pct(tgtPct)}
            sub={`${n0(k.sold)} ÷ ${n0(k.target)}`}
            icon={<Percent size={18} />} {...KPI.conversion} />
          <StatCard label="Coverage" value={pct(k.coverage)}
            sub={`${n0(k.contacted)} of ${n0(k.dealers)} dealerships`}
            icon={<Store size={18} />} {...KPI.activity} />
        </div>
      )}

      {/* The funnel for the products that publish one, when the selection as a
          whole does not. Its own row, headed with the products it covers — the
          figures below are a subset of the row above, and unlabelled they would
          read as disagreeing with it. */}
      {k && !funnel && fs && (
        <div className="bg-white border border-orange-100 rounded-2xl p-5 flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-bold text-gray-800">
              {fs.products.map(categoryLabel).join(" · ")} — volume and share
            </h3>
            <p className="text-[11px] text-gray-500">
              {fs.products.map(categoryLabel).join(" and ")} only, not the whole
              selection: this OEM publishes a total for{" "}
              {fs.products.length === 1 ? "that product" : "those products"} and not
              for the rest, and one product's sales over another's volume is not a share.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={oemTotalLabel} value={nOr(fs.oem_total)}
              icon={<CarFront size={18} />} {...KPI.neutral} />
            {!fullCoverage && (
              <StatCard label={FS.avail} value={nOr(fs.ysasc)}
                icon={<Barcode size={18} />} {...KPI.neutral} />
            )}
            <StatCard label={FS.sale} value={n0(fs.ys_sale)}
              icon={<Package size={18} />} {...KPI.ours} />
            <StatCard label={FS.share} value={pct(fs.penetration)}
              sub={fullCoverage ? `${n0(fs.ys_sale)} ÷ ${nOr(fs.oem_total)} — their whole volume`
                   : `${n0(fs.ys_sale)} ÷ ${nOr(fs.ysasc)}`}
              icon={<Target size={18} />} {...KPI.conversion} />
          </div>
          <Explain>
            <b className="text-gray-600">{FS.share}</b> is what we won of what we could
            have won. {fullCoverage
              ? "We hold a part number for this OEM's whole range, so everything they sold was winnable and the share is simply ours over theirs — there is no separate addressable figure to show."
              : "The denominator is only the covers we make a part for, so it never charges us for business we could not have taken."}{" "}
            A high figure means little headroom left at these dealers, not that they are small;
            a low one is where the volume already exists and is going to someone else.
          </Explain>
        </div>
      )}

      {noSales && data && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
          <b>No dealer sales for {oem || "this selection"} in this period.</b> Coverage and
          contact counts are real here, but volumes and targets stay empty until the OE
          team's dealer file carries a tab for it — or until this period is one the tab
          covers.
        </div>
      )}

      {data && !noSales && (
        <>
          {/* Both axes of the map, both bands of the trend and the whole of the
              contact-effect panel are penetration — without a total to divide
              by there is nothing for them to plot, so they are left out rather
              than drawn empty. */}
          {funnel && (
            <DealerMap dealers={data.dealers} avgPene={avgPene} fullCoverage={fullCoverage}
              onPick={(d) => setOpenDealer(d.id)} />
          )}
          <DealerRankTable dealers={data.dealers} avgPene={avgPene} funnel={funnel}
            fullCoverage={fullCoverage} products={data.capabilities.products}
            onPick={(d) => setOpenDealer(d.id)} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CoveragePanel rows={data.by_salesperson} />
            <QuarterPanel rows={data.by_quarter} funnel={funnel} oems={oems} />
          </div>
          {funnel && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <DealerTrend rows={data.by_month} benchmark={avgPene} oems={oems} />
              <ContactEffectPanel data={data.contact_effect} oems={oems} />
            </div>
          )}
        </>
      )}

      {data && noSales && <CoveragePanel rows={data.by_salesperson} />}

      {/* The complete searchable list — kept even when there are no sales for
          this OEM yet, because the dealers and their contact history are real. */}
      {data && data.dealers.length > 0 && (
        <DealerDirectory dealers={data.dealers} avgPene={avgPene} funnel={funnel}
          fullCoverage={fullCoverage} products={data.capabilities.products}
          onPick={(d) => setOpenDealer(d.id)} />
      )}

      <AnimatePresence>
        {openDealer && (
          // The tab's period goes in with it: the drawer's headline figures are
          // scoped to the same window as the row that was clicked, so the two
          // reconcile instead of appearing to disagree.
          <DealerDrawer dealerId={openDealer} headers={headers} benchmark={avgPene}
            periodQuery={{
              ...(periodParams(period.mode, period.token, period.range) ?? {}),
              ...(product ? { product } : {}),
            }}
            onClose={() => setOpenDealer(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
