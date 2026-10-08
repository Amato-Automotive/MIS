import { Fragment, useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CarFront, Phone, Footprints, Building2, Users, RefreshCw, Plus, Trash2,
  Search, History, CheckCircle2, XCircle, Clock, Target, X,
  Printer, ChevronRight, Percent, TrendingUp, MessageSquare, Tag,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, LabelList,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { formatCompact, formatCompactNos, formatDate } from "@/lib/format";

import {
  API_URL, MONTH_FULL, MONTH_SHORT,
  VISIT_COLOR, CALL_COLOR, TGT_TRACK, NEUTRAL_BAR, CHART_LABEL, OVER_COLOR,
  UNOWNED_COLOR, ON_TRACK_PCT, QUARTER_MONTHS,
  periodParams, periodMonthBounds, monthInBounds, PeriodControls, usePeriod,
  FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, SyncButton, FILTER_LABELS, filterOpts,
  monthToken, tokenLabel, shortDate, firstName, coverageColor, ModeBadge, StatCard, KPI,
  categoryLabel, useOEScope, ScopeNote, barWidth, achColor, BulletChart, useSyncLatest,
  type Period, type BulletDatum,
} from "./oe-network/shared";
import OemTargetsTab from "./oe-network/OemTargetsTab";
import DealersTab from "./oe-network/dealers";
import MyVisitsTab from "./oe-network/MyVisitsTab";

// ── Types ─────────────────────────────────────────────────────────────────────
interface OESource {
  id: string; sheet_id: string; label: string;
  sheet_type: "visit_plan" | "log_book" | "targets" | "dealer_data" | "oem_target";
  calendar_year: number | null; month: number | null; quarter: string | null;
  created_at: string | null; last_synced_at: string | null; last_sync_status: string | null;
}
interface SyncResult {
  rows_total: number; rows_inserted: number; rows_deleted: number;
  skipped_tabs: string[]; errors: string[]; status: string;
}
interface PvaRow {
  salesperson: string; log_name: string | null; planned: number; dealers_planned: number;
  visits: number; calls: number; total_logged: number; dealerships_contacted: number;
  /** Visits done over visits PLANNED. A completion figure, not network reach —
   *  it routinely exceeds 100%, and a rep can clear their plan while visiting
   *  the same handful of dealerships over and over. The word "coverage" belongs
   *  to the Dealers tab, where it means dealerships contacted out of
   *  dealerships assigned. */
  plan_pct: number | null;
}
interface GroupRow { key: string; total: number; visits: number; calls: number; dealerships: number; }
interface LogAnalytics {
  kpis: {
    total_logs: number; visits: number; calls: number; dealerships: number; salespersons: number;
    avg_car_sales: number | null; avg_seat_cover_sales: number | null; avg_mats_sales: number | null;
  };
  by_salesperson: GroupRow[]; by_oem: GroupRow[]; by_state: GroupRow[];
  monthly_trend: { year: number; month: number; total: number; visits: number; calls: number }[];
}

interface DealerRow {
  dealer_name: string; oem: string | null; city: string | null; state: string | null;
  last_salesperson: string | null; last_mode: string | null; last_remark: string | null;
  last_contact: string | null; days_since: number | null;
  total: number; visits: number; calls: number;
  avg_car_sales: number | null; avg_seat_cover_sales: number | null; attach_pct: number | null;
}
interface DealerContact {
  visit_date: string; salesperson: string | null; contact_mode: string | null; oem: string | null;
  designation: string | null; car_sales: number | null; seat_cover_sales: number | null;
  mats_sales: number | null; remarks: string | null; city: string | null; state: string | null;
}
interface AdhDealer {
  dealer_name: string; oem: string | null; city: string | null; planned_visits: number;
  status: "visited" | "called" | "missed"; log_dealership: string | null;
  visits: number; calls: number;
}
interface AdhRow {
  salesperson: string; log_name: string | null;
  planned: number; visited: number; called_only: number; missed: number;
  adherence_pct: number | null; touch_pct: number | null; unplanned_count: number;
  dealers: AdhDealer[];
  unplanned: { dealership: string; oem: string | null; visits: number; calls: number }[];
}
interface AttachOem {
  oem: string; dealers: number; attach_pct: number | null;
  mats_attach_pct: number | null; avg_car_sales: number | null;
}

/** Every targets payload carries units AND money side by side — they tell
 *  different stories (Hyundai AMJ: 72% on units, 84% on money), so the tab
 *  toggles between them without refetching and neither is "the" number. */
interface TgtMetrics {
  tgt_nos: number; ach_nos: number; tgt_value: number; ach_value: number;
  ach_pct_nos: number | null; ach_pct_value: number | null;
  gap_nos: number; gap_value: number;
}
interface TgtGroup extends TgtMetrics { key: string; region?: string | null }
interface TgtSummary {
  fy_year: number; quarter: number; label: string;
  kpis: TgtMetrics;
  by_salesperson: TgtGroup[];
  by_oem: TgtGroup[];
  by_oem_category: (TgtMetrics & { oem: string; key: string })[];
  by_region: TgtGroup[];
  by_month: (TgtMetrics & { year: number; month: number })[];
  /** Targets nobody owns — MSIL and TATA book accessories as one line inside
   *  their seat-cover block. They're in the KPIs but can't be in the
   *  salesperson or region charts, so those charts show this row explicitly
   *  rather than quietly adding up to less than the headline. */
  unattributed: (TgtMetrics & { oems: string[] }) | null;
  value_scales: Record<string, string>;
}
interface TgtPeriod { fy_year: number; quarter: number; token: string; label: string }

// ── Remarks ───────────────────────────────────────────────────────────────────
interface RemarkTheme { key: string; label: string; count: number }
/** One note = one remark category the rep filled in. Since 29 Jul 2026 the form
 *  makes them tick categories and write separately in each, so a single visit
 *  routinely carries two or three of these. */
interface RemarkNote { category: string; label: string; text: string; themes: string[] }
/** A category with its own nested theme breakdown — the primary axis of this tab. */
interface RemarkCategory { key: string; label: string; count: number; themes: RemarkTheme[] }
interface RemarkLatest {
  visit_date: string; dealership: string | null; oem: string | null;
  contact_mode: string | null; notes: RemarkNote[]; themes: string[];
}
interface PersonRollup {
  salesperson: string; remarks: number; visits: number; calls: number; dealers: number;
  top_themes: RemarkTheme[]; categories: { key: string; label: string; count: number }[];
  latest: RemarkLatest | null;
}
interface RemarkFeedRow {
  id: string; visit_date: string; salesperson: string | null; contact_mode: string | null;
  oem: string | null; dealership: string | null; city: string | null; state: string | null;
  notes: RemarkNote[]; themes: string[];
}
interface RemarksData {
  kpis: { remarks: number; notes: number; dealers: number; salespersons: number; visits: number; calls: number };
  categories: RemarkCategory[];
  themes: RemarkTheme[];
  by_salesperson: PersonRollup[];
  feed: { total: number; page: number; per_page: number; data: RemarkFeedRow[] };
}

// Each theme reads in its own muted colour everywhere it appears (chips in the
// feed, the rollup cards, and the theme filter row) so the eye can track a theme
// across the page. Keys mirror services/remark_themes.py.
const THEME_META: Record<string, { label: string; color: string; bg: string }> = {
  order_booked: { label: "Order booked", color: "#16a34a", bg: "#f0fdf4" },
  order_push: { label: "Order pushed", color: "#f46617", bg: "#fff4ed" },
  follow_up: { label: "Follow-up", color: "#d97706", bg: "#fffbeb" },
  product_pitch: { label: "Catalogue pitched", color: "#3b82f6", bg: "#eff6ff" },
  back_order: { label: "Back order", color: "#dc2626", bg: "#fef2f2" },
  stock: { label: "Stock", color: "#0d9488", bg: "#f0fdfa" },
  payment_issue: { label: "Fund / payment", color: "#e11d48", bg: "#fff1f2" },
  new_dealer: { label: "New dealer", color: "#a855f7", bg: "#f5f3ff" },
  incentive: { label: "Incentive", color: "#6366f1", bg: "#eef2ff" },
  market_feedback: { label: "Market", color: "#64748b", bg: "#f1f5f9" },
  complaint: { label: "Concern", color: "#b91c1c", bg: "#fef2f2" },
};
const themeMeta = (key: string) => THEME_META[key] ?? { label: key, color: "#6b7280", bg: "#f9fafb" };

// The four categories the rep picks on the form, plus `general` for the
// pre-29-Jul-2026 rows that only ever had one unlabelled blob. Keys mirror
// REMARK_CATEGORIES in routers/oe_network.py.
const CATEGORY_META: Record<string, { color: string; bg: string }> = {
  sales: { color: "#16a34a", bg: "#f0fdf4" },
  product_feedback: { color: "#3b82f6", bg: "#eff6ff" },
  replacement: { color: "#d97706", bg: "#fffbeb" },
  others: { color: "#a855f7", bg: "#f5f3ff" },
  general: { color: "#6b7280", bg: "#f4f4f5" },
};
const categoryMeta = (key: string) => CATEGORY_META[key] ?? { color: "#6b7280", bg: "#f9fafb" };

type TabId = "overview" | "indepth" | "dealers" | "activity" | "targets" | "oemtargets"
  | "sheets" | "myvisits";
type Metric = "value" | "nos";

function Pagination({ page, total, perPage, onPage }: {
  page: number; total: number; perPage: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-3">
      <p className="text-[11px] text-gray-500">
        Page {page} of {pages} · {total.toLocaleString("en-IN")} rows
      </p>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 disabled:opacity-40">
          Previous
        </button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 disabled:opacity-40">
          Next
        </button>
      </div>
    </div>
  );
}

const inputClass =
  "h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all";

/**
 * Target-vs-actual bullet rows, one per salesperson. Grey track = visits planned,
 * orange fill = visits actually done (past the tick means they beat the plan),
 * blue bar = calls, which are real work but never count toward coverage.
 * Every bar shares one scale, so lengths are comparable across the team.
 */
function PlanVsActualChart({ rows }: { rows: PvaRow[] }) {
  // Ranked best-to-worst — the point of the chart is who is off plan.
  // "No plan" people have no coverage to rank, so they sit at the bottom.
  const ranked = [...rows].sort((a, b) => {
    if (a.plan_pct == null) return b.plan_pct == null ? 0 : 1;
    if (b.plan_pct == null) return -1;
    return b.plan_pct - a.plan_pct;
  });
  const max = Math.max(1, ...rows.flatMap((r) => [r.planned, r.visits, r.calls]));
  const w = (n: number) => barWidth(n, max);

  if (ranked.length === 0) {
    return <p className="text-xs text-gray-500 py-6 text-center">No plan or log data for this period</p>;
  }

  return (
    <div className="flex flex-col gap-3.5 pt-1">
      {ranked.map((r) => (
        <div key={r.salesperson} className="flex items-center gap-3">
          <div className="w-[118px] shrink-0 min-w-0">
            <p className="text-xs font-semibold text-gray-700 truncate"
              title={r.log_name && r.log_name !== r.salesperson ? `${r.salesperson} · logs as ${r.log_name}` : r.salesperson}>
              {r.salesperson}
            </p>
            {r.planned === 0 && <p className="text-[9px] font-bold uppercase text-amber-600">no plan</p>}
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {/* Visits against the plan — the grey track ends at the plan, so it
                marks the goal on its own; only an overshoot needs a notch. */}
            <div className="relative h-5">
              {r.planned > 0 && (
                <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(r.planned), background: TGT_TRACK }} />
              )}
              <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(r.visits), background: VISIT_COLOR }} />
              {r.visits > r.planned && r.planned > 0 && (
                <div className="absolute inset-y-0 w-[2px]" style={{ left: w(r.planned), background: "rgba(255,255,255,0.9)" }} />
              )}
              {/* Done-out-of-planned reads at the bar tip, where the eye already is.
                  The planned figure is dark, NOT grey: it lands on the pale grey
                  planned track, so a grey-on-grey number was unreadable — and it
                  is half the comparison the row exists to make. Dark neutral
                  rather than blue, which already means "call" on this chart. */}
              <span className="absolute top-1/2 -translate-y-1/2 text-[10px] font-bold leading-none whitespace-nowrap"
                style={{ left: `calc(${w(r.visits)} + 5px)`, color: VISIT_COLOR }}>
                {r.visits}
                {r.planned > 0 && <span className="text-gray-800">/{r.planned}</span>}
              </span>
            </div>
            {/* Calls — same scale, deliberately outside the coverage measure */}
            <div className="relative h-2.5">
              <div className="absolute inset-y-0 left-0 rounded" style={{ width: w(r.calls), background: CALL_COLOR }} />
              <span className="absolute top-1/2 -translate-y-1/2 text-[9px] font-bold leading-none"
                style={{ left: `calc(${w(r.calls)} + 5px)`, color: CALL_COLOR }}>
                {r.calls}
              </span>
            </div>
          </div>

          <div className="w-[72px] shrink-0 text-right">
            <p className={`text-sm font-black leading-none ${coverageColor(r.plan_pct)}`}>
              {r.plan_pct != null ? `${r.plan_pct}%` : "—"}
            </p>
            {/* The two numbers answer different questions and must be read
                together: 114% of plan across 30 dealerships is a rep working
                a narrow patch hard, not a rep who covered the network. */}
            <p className="text-[9px] text-gray-500 mt-0.5">of plan · {r.dealerships_contacted} dealers</p>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-4 flex-wrap pt-1">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: VISIT_COLOR }} /> Visits done
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CALL_COLOR }} /> Calls
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          {/* Outlined: TGT_TRACK is a background track colour, so as a bare
              swatch on a white card it is all but invisible. */}
          <span className="w-2.5 h-2.5 rounded-sm"
            style={{ background: TGT_TRACK, border: "1px solid #b6bcc6" }} /> Planned
        </span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Overview tab — plan-vs-actual coverage + log analytics for one month
// ══════════════════════════════════════════════════════════════════════════════
function OverviewTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson: scopeName } = useOEScope();
  const toast = useToast();
  const period = usePeriod("monthly");
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[]; contact_modes: string[] } | null>(null);
  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [mode, setMode] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [pva, setPva] = useState<{ rows: PvaRow[]; totals: { planned: number; visits: number; calls: number; dealerships: number; dealerships_matched: number; plan_pct: number | null } } | null>(null);
  const [analytics, setAnalytics] = useState<LogAnalytics | null>(null);
  const [trend, setTrend] = useState<LogAnalytics["monthly_trend"]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  // The trend follows the period like every other panel; the surrounding
  // history is one click away rather than the default.
  const [trendScope, setTrendScope] = useState<"period" | "all">("period");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes, srcRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/periods`, { headers }),
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
        fetch(`${API_URL}/oe-network/sheet-sources`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (srcRes.ok) {
        const sources: OESource[] = await srcRes.json();
        const stamps = sources.map((s) => s.last_synced_at).filter(Boolean) as string[];
        setLastSynced(stamps.length ? stamps.sort()[stamps.length - 1] : null);
      }
      if (!perRes.ok) { setLoading(false); return; }
      const data = await perRes.json();
      // Either sheet can carry a month the other doesn't, so the union is what
      // the picker should offer. buildPeriodOptions dedupes the overlap.
      const union: Period[] = [...data.plan_months, ...data.log_months];
      period.setMonths(union);
      if (!union.length) setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Land on the newest month that has data, and keep the user's chosen period
  // across sync refreshes — this only fires while nothing is selected.
  useEffect(() => {
    if (!period.token && period.options.length) period.setToken(period.options[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.options]);

  const { syncing, syncAll } = useSyncLatest(headers, () => setRefresh((x) => x + 1), ["log", "plan"]);

  useEffect(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    if (!pp) return;
    // Same entity filters everywhere; mode applies only to the log analytics
    // (coverage is by definition visits-vs-plan), period scoping only to the
    // non-trend calls.
    const entity = new URLSearchParams();
    if (salesperson) entity.set("salesperson", salesperson);
    if (oem) entity.set("oem", oem);
    if (state) entity.set("state", state);
    if (city) entity.set("city", city);
    if (qDebounced) entity.set("q", qDebounced);
    const logParams = new URLSearchParams(entity);
    if (mode) logParams.set("contact_mode", mode);
    const periodScoped = new URLSearchParams(logParams);
    const pvaParams = new URLSearchParams(entity);
    for (const [k, v] of Object.entries(pp)) {
      periodScoped.set(k, v);
      pvaParams.set(k, v);
    }

    // Abort on supersede: three requests go out per filter change, and without
    // this a slow earlier set can resolve after a newer one and leave the page
    // showing a filter the user has already moved off.
    const ctrl = new AbortController();
    const opts = { headers, signal: ctrl.signal };
    setLoading(true);
    (async () => {
      try {
        const [pvaRes, anaRes, allRes] = await Promise.all([
          fetch(`${API_URL}/oe-network/plan-vs-actual?${pvaParams}`, opts),
          fetch(`${API_URL}/oe-network/log-analytics?${periodScoped}`, opts),
          fetch(`${API_URL}/oe-network/log-analytics?${logParams}`, opts),
        ]);
        if (pvaRes.ok) setPva(await pvaRes.json());
        if (anaRes.ok) setAnalytics(await anaRes.json());
        if (allRes.ok) setTrend((await allRes.json()).monthly_trend);
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.token, period.mode, period.range, salesperson, oem, state, city, mode, qDebounced, refresh]);

  const hasFilters = Boolean(salesperson || oem || state || city || mode || q);
  const clearFilters = () => {
    setSalesperson(""); setOem(""); setState(""); setCity(""); setMode(""); setQ("");
  };

  if (!loading && period.months.length === 0) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
        {scoped
          ? <>Nothing recorded under <b>{scopeName}</b> yet. Your planned and completed
              visits appear here once the log book is synced — press <b>Sync</b> above
              if you have submitted visits today.</>
          : <>No data yet — register and sync the visit plan and log book sheets from the <b>Data Source Sheets</b> tab.</>}
      </div>
    );
  }

  const salespersonChart = (analytics?.by_salesperson ?? []).map((r) => ({
    name: r.key, Visits: r.visits, Calls: r.calls, Total: r.total,
  }));
  const stateChart = (analytics?.by_state ?? []).slice(0, 10).map((r) => ({ name: r.key, Contacts: r.total }));
  // The trend arrives whole (it is the one call that is not period-scoped
  // server-side) and is cut here, so switching scope costs no request.
  const trendBounds = periodMonthBounds(period.mode, period.token, period.range);
  const trendChart = trend
    .filter((t) => trendScope === "all" || monthInBounds(t.year, t.month, trendBounds))
    .map((t) => ({
      name: `${MONTH_SHORT[t.month - 1]} ${String(t.year).slice(2)}`, Visits: t.visits, Calls: t.calls,
    }));
  // "All time" is only a distinct choice when a period is actually narrowing it.
  const trendScopeable = trendBounds !== null;


  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        {!scoped && (
          <Select value={salesperson} onChange={setSalesperson}
            options={filterOpts(options?.salespersons, "salesperson")}
            placeholder={FILTER_LABELS.salesperson.placeholder} />
        )}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={state} onChange={setState} options={filterOpts(options?.states, "state")}
          placeholder={FILTER_LABELS.state.placeholder} />
        <Select value={city} onChange={setCity} options={filterOpts(options?.cities, "city")}
          placeholder={FILTER_LABELS.city.placeholder} />
        <Select value={mode} onChange={setMode} options={filterOpts(options?.contact_modes, "mode")}
          placeholder={FILTER_LABELS.mode.placeholder} />
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealership…"
            className={`${inputClass} pl-8 w-40`} />
        </div>
        <ClearFilters show={hasFilters} onClear={clearFilters} />
        <FilterSpinner show={loading} />
        <FilterActions>
          {lastSynced && (
            <span className="text-[10px] text-gray-500 hidden xl:block" title="Most recent sheet sync">
              Data as of {formatDate(lastSynced)}
            </span>
          )}
          <RefreshButton onClick={() => setRefresh((x) => x + 1)} disabled={loading} />
          <SyncButton onClick={syncAll} syncing={syncing}
            title="Re-pull the log book and the latest visit plan from Google Sheets" />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      {scoped && scopeName && <ScopeNote salesperson={scopeName} />}

      {/* Visit plans are written per month with no day on them, so coverage can
          only be measured month-for-month. Saying so beats showing a percentage
          that looks like it honours the dates and doesn't. */}
      {period.mode === "custom" && period.range.from && period.range.to && (
        <p className="no-print text-[11px] text-gray-500 -mt-2">
          Plans are set monthly, so this compares whole months
          ({shortDate(period.range.from)} → {shortDate(period.range.to)} covers{" "}
          {MONTH_SHORT[Number(period.range.from.slice(5, 7)) - 1]}–{MONTH_SHORT[Number(period.range.to.slice(5, 7)) - 1]}).
          Field activity below is counted to the exact day.
        </p>
      )}

      {/* Print-only context line — the filter bar is hidden on paper */}
      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          {period.options.find((o) => o.value === period.token)?.label ?? ""}
          {salesperson && ` · ${salesperson}`}{oem && ` · ${oem}`}{state && ` · ${state}`}
          {city && ` · ${city}`}{mode && ` · ${mode}`}{qDebounced && ` · “${qDebounced}”`}
        </p>
        <p className="text-[10px] text-gray-500">
          {lastSynced ? `Data as of ${formatDate(lastSynced)} · ` : ""}
          Printed {new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Planned Visits" value={pva?.totals.planned ?? 0}
          icon={<Target size={18} />} {...KPI.target} />
        <StatCard label="Visits Done" value={pva?.totals.visits ?? 0}
          icon={<Footprints size={18} />} {...KPI.visits} />
        <StatCard label="Calls Made" value={pva?.totals.calls ?? 0}
          icon={<Phone size={18} />} {...KPI.calls} />
        {/* NOT "Coverage". This is visits done over visits planned and goes
            past 100% whenever the team out-works its plan; coverage means
            dealerships reached out of dealerships assigned, and lives on the
            Dealers tab. The two were both called Coverage and read as one. */}
        <StatCard label="Plan Completion" value={pva?.totals.plan_pct != null ? `${pva.totals.plan_pct}%` : "—"}
          sub={`${fmtNos(pva?.totals.visits ?? 0)} visits ÷ ${fmtNos(pva?.totals.planned ?? 0)} planned`}
          icon={<CheckCircle2 size={18} />} {...KPI.conversion} />
        {/* Every dealership the team NAMED this period, which is not the same
            population as the Dealers tab's — that one counts only dealerships
            the OE dealer file knows about, because coverage, penetration and
            target all divide by figures out of that file. Both are right. The
            matched count is printed underneath so the smaller number reads as a
            subtotal of this one rather than as a contradiction found later. */}
        <StatCard label="Dealerships" value={pva?.totals.dealerships ?? analytics?.kpis.dealerships ?? 0}
          sub={pva?.totals.dealerships_matched != null
            ? `${fmtNos(pva.totals.dealerships_matched)} in the OE dealer list`
            : "contacted this period"}
          icon={<Building2 size={18} />} {...KPI.reach} />
      </div>

      {/* Plan vs actual */}
      <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Plan vs Actual — by Salesperson</h3>
        <p className="text-[10px] text-gray-500 mb-1">Ranked by plan completion — field visits against the advance plan</p>
        <PlanVsActualChart rows={pva?.rows ?? []} />
        <p className="text-[10px] text-gray-500 mt-3">
          Plan completion compares field visits (not calls) against the advance plan, so it passes 100% whenever
          more visits were made than planned. It is <b className="text-gray-600">not</b> network reach — the same
          dealership visited four times counts four visits and one dealership. For how much of the network was
          actually touched, see Coverage on the <b className="text-gray-600">Dealers</b> tab. Names are matched
          across the two sheets automatically.
          {/* This panel is the one thing on the tab the Mode filter does NOT
              reach — coverage is visits-vs-plan by definition. Silently not
              responding reads as a bug, so say it, but only when it applies. */}
          {mode && (
            <> The <b className="text-gray-500">{mode}</b> filter does not apply here:
              a plan is a plan of visits, so this panel always measures visits.</>
          )}
        </p>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Activity by Salesperson</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={salespersonChart} margin={{ top: 16, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false}
                interval={0} tickFormatter={firstName} />
              <YAxis tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Visits" stackId="a" fill={VISIT_COLOR} radius={[0, 0, 0, 0]}>
                <LabelList dataKey="Visits" position="center" fill="#ffffff" fontSize={10} fontWeight={700}
                  formatter={(v: number) => (v > 0 ? v : "")} />
              </Bar>
              <Bar dataKey="Calls" stackId="a" fill={CALL_COLOR} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="Calls" position="center" fill="#ffffff" fontSize={10} fontWeight={700}
                  formatter={(v: number) => (v > 0 ? v : "")} />
                <LabelList dataKey="Total" position="top" fill="#6b7280" fontSize={10} fontWeight={700} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                Monthly Trend{trendScope === "all" || !trendScopeable ? " — All Time" : ""}
              </h3>
              <p className="text-[10px] text-gray-500 mb-3">
                {trendScope === "all" || !trendScopeable
                  ? "Every month on record"
                  : "The months in the selected period"}
                {hasFilters ? " · follows the other filters too" : ""}.
              </p>
            </div>
            {/* Only offered when a period is actually narrowing the data —
                on "all time" the two choices would show the same chart. */}
            {trendScopeable && (
              <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5 shrink-0 no-print">
                {([["period", "Period"], ["all", "All time"]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setTrendScope(k)}
                    className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
                      trendScope === k ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {trendChart.length === 0 ? (
            <div className="h-[260px] flex flex-col items-center justify-center gap-2">
              <p className="text-sm text-gray-500">No activity in the selected period.</p>
              <button onClick={() => setTrendScope("all")}
                className="text-xs font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                Show all time instead
              </button>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={trendChart} margin={{ top: 16, right: 16, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {/* A one-month period is a single point: without a visible dot a
                    line chart of one value draws nothing at all. */}
                <Line type="monotone" dataKey="Visits" stroke={VISIT_COLOR} strokeWidth={2}
                  dot={{ r: trendChart.length === 1 ? 5 : 3 }} />
                <Line type="monotone" dataKey="Calls" stroke={CALL_COLOR} strokeWidth={2}
                  dot={{ r: trendChart.length === 1 ? 5 : 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* OEM breakdown — table with inline bars (few rows, exact values matter) */}
        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">By OEM</h3>
          <div className="flex flex-col gap-2">
            {(analytics?.by_oem ?? []).map((r) => {
              const max = Math.max(...(analytics?.by_oem ?? []).map((x) => x.total), 1);
              return (
                <div key={r.key} className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-gray-600 w-24 shrink-0 truncate" title={r.key}>{r.key}</span>
                  <div className="flex-1 h-5 bg-gray-50 rounded-md overflow-hidden flex">
                    <div className="flex items-center justify-center text-[9px] font-bold text-white"
                      style={{ width: `${(r.visits / max) * 100}%`, background: VISIT_COLOR }} title={`${r.visits} visits`}>
                      {r.visits / max >= 0.07 ? r.visits : ""}
                    </div>
                    <div className="flex items-center justify-center text-[9px] font-bold text-white"
                      style={{ width: `${(r.calls / max) * 100}%`, background: CALL_COLOR, marginLeft: 2 }} title={`${r.calls} calls`}>
                      {r.calls / max >= 0.07 ? r.calls : ""}
                    </div>
                  </div>
                  <span className="text-xs font-bold text-gray-700 w-10 text-right">{r.total}</span>
                </div>
              );
            })}
            {(analytics?.by_oem ?? []).length === 0 && <p className="text-xs text-gray-500">No data</p>}
          </div>
          <div className="flex items-center gap-4 mt-3">
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: VISIT_COLOR }} /> Visits
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CALL_COLOR }} /> Calls
            </span>
          </div>
        </div>

        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Top States by Contacts</h3>
          <ResponsiveContainer width="100%" height={Math.max(160, stateChart.length * 26)}>
            <BarChart data={stateChart} layout="vertical" margin={{ top: 0, right: 24, left: 30, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: CHART_LABEL }} width={90} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }} />
              <Bar dataKey="Contacts" fill={VISIT_COLOR} radius={[0, 4, 4, 0]} barSize={12}>
                <LabelList dataKey="Contacts" position="right" fill="#6b7280" fontSize={10} fontWeight={700} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Dealer-reported averages */}
      {analytics?.kpis.avg_car_sales != null && (
        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Dealer-Reported Monthly Figures (averages)</h3>
          <p className="text-[10px] text-gray-500 mb-3">
            Average of what dealerships reported during contacts — these are the dealers' own monthly numbers, not Amato sales.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Avg Car Sales" value={analytics.kpis.avg_car_sales ?? "—"} icon={<CarFront size={18} />} {...KPI.neutral} />
            <StatCard label="Avg Seat Cover Sales" value={analytics.kpis.avg_seat_cover_sales ?? "—"} icon={<Users size={18} />} {...KPI.neutral} />
            <StatCard label="Avg Mats Sales" value={analytics.kpis.avg_mats_sales ?? "—"} icon={<Users size={18} />} {...KPI.neutral} />
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// In-Depth tab — dealer network health, dealer-level plan adherence, attach rates
// ══════════════════════════════════════════════════════════════════════════════

/** "How long since we touched this dealer" — green ≤15d, amber ≤45d, red beyond. */
function RecencyBadge({ days }: { days: number | null }) {
  if (days == null) return <span className="text-gray-400">—</span>;
  const label = days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
  const [color, bg] =
    days <= 15 ? ["#16a34a", "#f0fdf4"] : days <= 45 ? ["#d97706", "#fffbeb"] : ["#ef4444", "#fef2f2"];
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: AdhDealer["status"] }) {
  const map: Record<AdhDealer["status"], [string, string, string]> = {
    visited: ["Visited", "#16a34a", "#f0fdf4"],
    called: ["Called only", CALL_COLOR, "#eff6ff"],
    missed: ["Missed", "#ef4444", "#fef2f2"],
  };
  const [label, color, bg] = map[status];
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

function InDepthTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson: scopeName } = useOEScope();
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[] } | null>(null);
  const [planMonths, setPlanMonths] = useState<Period[]>([]);

  // Plan adherence (dealer-level, one month at a time — plans are monthly)
  const [adhMonth, setAdhMonth] = useState("");
  const [adhSp, setAdhSp] = useState("");
  const [adh, setAdh] = useState<{
    rows: AdhRow[];
    totals: { planned: number; visited: number; called_only: number; missed: number; unplanned: number; adherence_pct: number | null; touch_pct: number | null };
  } | null>(null);
  const [adhLoading, setAdhLoading] = useState(false);
  const [expandedSp, setExpandedSp] = useState<string | null>(null);

  // Dealer directory
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [sort, setSort] = useState("recent");
  const [dirOem, setDirOem] = useState("");
  const [dirState, setDirState] = useState("");
  const [dirSp, setDirSp] = useState("");
  const [page, setPage] = useState(1);
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [dirTotal, setDirTotal] = useState(0);
  const [dirSummary, setDirSummary] = useState<{ dealers: number; active_30: number; stale_45: number } | null>(null);
  const [dirLoading, setDirLoading] = useState(true);
  const [expandedDealer, setExpandedDealer] = useState<string | null>(null);
  const [histories, setHistories] = useState<Record<string, DealerContact[]>>({});

  // Attach rates (all-time — dealer figures are monthly self-reports)
  const [attach, setAttach] = useState<{ overall: { dealers: number; attach_pct: number | null }; by_oem: AttachOem[] } | null>(null);

  const perPage = 25;

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes, attRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/periods`, { headers }),
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
        fetch(`${API_URL}/oe-network/attach-rates`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (attRes.ok) setAttach(await attRes.json());
      if (perRes.ok) {
        const p = await perRes.json();
        setPlanMonths(p.plan_months);
        if (p.plan_months.length) setAdhMonth(monthToken(p.plan_months[p.plan_months.length - 1]));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!adhMonth) return;
    const [y, m] = adhMonth.split("-");
    const params = new URLSearchParams({ year: y, month: m });
    if (adhSp) params.set("salesperson", adhSp);
    setAdhLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/plan-adherence?${params}`, { headers });
      if (res.ok) setAdh(await res.json());
      setAdhLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adhMonth, adhSp]);

  useEffect(() => { setPage(1); }, [qDeb, sort, dirOem, dirState, dirSp]);

  useEffect(() => {
    const params = new URLSearchParams({ sort, page: String(page), per_page: String(perPage) });
    if (qDeb) params.set("q", qDeb);
    if (dirOem) params.set("oem", dirOem);
    if (dirState) params.set("state", dirState);
    if (dirSp) params.set("salesperson", dirSp);
    setDirLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/dealers?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setDealers(data.data);
        setDirTotal(data.total);
        setDirSummary(data.summary);
      }
      setDirLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeb, sort, dirOem, dirState, dirSp, page]);

  const toggleDealer = async (name: string) => {
    if (expandedDealer === name) { setExpandedDealer(null); return; }
    setExpandedDealer(name);
    if (!histories[name]) {
      const res = await fetch(`${API_URL}/oe-network/dealers/history?name=${encodeURIComponent(name)}`, { headers });
      if (res.ok) {
        const d = await res.json();
        setHistories((prev) => ({ ...prev, [name]: d.contacts }));
      }
    }
  };

  const adhMonthOptions = planMonths
    .map((p) => ({ value: monthToken(p), label: tokenLabel(monthToken(p)) }))
    .reverse();
  const sortOptions = [
    { value: "recent", label: "Recently contacted" },
    { value: "stale", label: "Stalest first" },
    { value: "most", label: "Most contacted" },
    { value: "name", label: "Name A–Z" },
  ];
  const attachMax = Math.max(...(attach?.by_oem ?? []).map((r) => r.attach_pct ?? 0), 1);

  return (
    <div className="flex flex-col gap-5">
      {scoped && scopeName && <ScopeNote salesperson={scopeName} />}
      {/* Network health KPIs — follow the directory filters below */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Network Dealers" value={dirSummary?.dealers ?? 0}
          sub="unique dealerships contacted" icon={<Building2 size={18} />} {...KPI.reach} />
        <StatCard label="Active" value={dirSummary?.active_30 ?? 0}
          sub="contacted in the last 30 days" icon={<CheckCircle2 size={18} />} {...KPI.conversion} />
        <StatCard label="Going Cold" value={dirSummary?.stale_45 ?? 0}
          sub="no contact for 45+ days" icon={<Clock size={18} />} {...KPI.danger} />
        <StatCard label="Avg Attach Rate" value={attach?.overall.attach_pct != null ? `${attach.overall.attach_pct}%` : "—"}
          sub="seat covers vs dealer car sales" icon={<Percent size={18} />} {...KPI.neutral} />
      </div>

      {/* Plan adherence — dealer level */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-start justify-between flex-wrap gap-2 mb-1">
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Plan Adherence — Dealer Level</h3>
            <p className="text-[10px] text-gray-500">
              Was each planned dealership actually contacted? Names are matched approximately across the two sheets.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {!scoped && (
              <Select value={adhSp} onChange={setAdhSp}
                options={filterOpts(options?.salespersons, "salesperson")}
                placeholder={FILTER_LABELS.salesperson.placeholder} />
            )}
            <Select value={adhMonth} onChange={setAdhMonth} options={adhMonthOptions} placeholder="Month…" />
            {adhLoading && <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
          </div>
        </div>

        {adh && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 py-2 text-[11px]">
            <span className={`font-bold ${coverageColor(adh.totals.adherence_pct)}`}>
              {adh.totals.adherence_pct != null ? `${adh.totals.adherence_pct}% adherence` : "No plan data"}
            </span>
            <span className="text-gray-500"><b className="text-gray-700">{adh.totals.planned}</b> planned dealers</span>
            <span className="text-green-600 font-semibold">{adh.totals.visited} visited</span>
            <span className="font-semibold" style={{ color: CALL_COLOR }}>{adh.totals.called_only} called only</span>
            <span className="text-red-500 font-semibold">{adh.totals.missed} missed</span>
            <span className="text-amber-600 font-semibold">{adh.totals.unplanned} contacted off-plan</span>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-1">
          {(adh?.rows ?? []).map((r) => (
            <div key={r.salesperson} className="border border-gray-100 rounded-xl overflow-hidden">
              <button onClick={() => setExpandedSp(expandedSp === r.salesperson ? null : r.salesperson)}
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-orange-50/40 text-left transition-colors">
                <ChevronRight size={14} className={`text-gray-400 shrink-0 transition-transform ${expandedSp === r.salesperson ? "rotate-90" : ""}`} />
                <span className="text-xs font-semibold text-gray-700 flex-1 min-w-0 truncate">
                  {r.salesperson}
                  {r.planned === 0 && (
                    <span className="ml-1.5 text-[9px] font-bold uppercase text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">no plan</span>
                  )}
                </span>
                <span className="hidden md:flex items-center gap-3 text-[11px] shrink-0">
                  <span className="text-gray-500">{r.planned} planned</span>
                  <span className="text-green-600 font-semibold">{r.visited} visited</span>
                  <span className="font-semibold" style={{ color: CALL_COLOR }}>{r.called_only} called</span>
                  <span className="text-red-500 font-semibold">{r.missed} missed</span>
                  {r.unplanned_count > 0 && <span className="text-amber-600 font-semibold">{r.unplanned_count} off-plan</span>}
                </span>
                <span className={`text-xs font-bold w-14 text-right shrink-0 ${coverageColor(r.adherence_pct)}`}>
                  {r.adherence_pct != null ? `${r.adherence_pct}%` : "—"}
                </span>
              </button>
              <AnimatePresence>
                {expandedSp === r.salesperson && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="px-4 pb-4 pt-2 border-t border-gray-50 flex flex-col gap-3">
                      {r.dealers.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                                <th className="py-1.5 pr-3">Planned Dealer</th>
                                <th className="py-1.5 pr-3">OEM</th>
                                <th className="py-1.5 pr-3">City</th>
                                <th className="py-1.5 pr-3">Status</th>
                                <th className="py-1.5 pr-3">Logged as</th>
                                <th className="py-1.5 pr-3 text-right">Visits</th>
                                <th className="py-1.5 text-right">Calls</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.dealers.map((d, i) => (
                                <tr key={i} className="border-b border-gray-50 last:border-0">
                                  <td className="py-1.5 pr-3 text-gray-700">{d.dealer_name}</td>
                                  <td className="py-1.5 pr-3 text-gray-500">{d.oem ?? "—"}</td>
                                  <td className="py-1.5 pr-3 text-gray-500">{d.city ?? "—"}</td>
                                  <td className="py-1.5 pr-3"><StatusPill status={d.status} /></td>
                                  <td className="py-1.5 pr-3 text-gray-500">
                                    {d.log_dealership && d.log_dealership.toLowerCase() !== d.dealer_name.toLowerCase()
                                      ? d.log_dealership : d.log_dealership ? "✓" : "—"}
                                  </td>
                                  <td className="py-1.5 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{d.visits || ""}</td>
                                  <td className="py-1.5 text-right font-semibold" style={{ color: CALL_COLOR }}>{d.calls || ""}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {r.unplanned.length > 0 && (
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mb-1.5">
                            Contacted but not on the plan ({r.unplanned_count})
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {r.unplanned.map((u, i) => (
                              <span key={i} className="text-[10px] text-gray-600 bg-amber-50/70 border border-amber-100 px-2 py-1 rounded-lg"
                                title={`${u.visits} visits · ${u.calls} calls${u.oem ? ` · ${u.oem}` : ""}`}>
                                {u.dealership}
                                <b className="ml-1 text-amber-700">{u.visits + u.calls}</b>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
          {!adhLoading && (adh?.rows ?? []).length === 0 && (
            <p className="text-xs text-gray-500 py-4 text-center">No plan or log data for this month</p>
          )}
        </div>
      </div>

      {/* Dealer directory */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Dealer Directory</h3>
            <p className="text-[10px] text-gray-500">Every dealership ever contacted — click a row for its full history</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0 ml-auto">
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealer…"
                className={`${inputClass} pl-8 w-40`} />
            </div>
            {!scoped && (
              <Select value={dirSp} onChange={setDirSp}
                options={filterOpts(options?.salespersons, "salesperson")}
                placeholder={FILTER_LABELS.salesperson.placeholder} />
            )}
            <Select value={dirOem} onChange={setDirOem} options={filterOpts(options?.oems, "oem")}
              placeholder={FILTER_LABELS.oem.placeholder} />
            <Select value={dirState} onChange={setDirState} options={filterOpts(options?.states, "state")}
              placeholder={FILTER_LABELS.state.placeholder} />
            <Select value={sort} onChange={setSort} options={sortOptions} placeholder="Sort" />
          </div>
        </div>

        {dirLoading ? (
          <div className="py-10 flex justify-center"><div className="w-5 h-5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-3">Dealership</th>
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Last Contact</th>
                    <th className="py-2 pr-3 text-right">Visits</th>
                    <th className="py-2 pr-3 text-right">Calls</th>
                    <th className="py-2 pr-3">Last By</th>
                    <th className="py-2 pr-3 text-right" title="Dealer's reported monthly car sales, averaged">Avg Cars</th>
                    <th className="py-2 pr-3 text-right" title="Seat-cover sales as % of the dealer's car sales">Attach</th>
                    <th className="py-2">Last Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {dealers.map((r) => (
                    <Fragment key={r.dealer_name}>
                      <tr onClick={() => toggleDealer(r.dealer_name)}
                        className="border-b border-gray-50 hover:bg-orange-50/40 cursor-pointer align-top">
                        <td className="py-2 pr-3 min-w-[160px]">
                          <span className="flex items-start gap-1">
                            <ChevronRight size={12} className={`text-gray-400 mt-0.5 shrink-0 transition-transform ${expandedDealer === r.dealer_name ? "rotate-90" : ""}`} />
                            <span>
                              <span className="font-semibold text-gray-700">{r.dealer_name}</span>
                              <span className="block text-[10px] text-gray-500">
                                {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-gray-600">{r.oem ?? "—"}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className="text-gray-500 mr-1.5">{shortDate(r.last_contact)}</span>
                          <RecencyBadge days={r.days_since} />
                        </td>
                        <td className="py-2 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{r.visits || "—"}</td>
                        <td className="py-2 pr-3 text-right font-semibold" style={{ color: CALL_COLOR }}>{r.calls || "—"}</td>
                        <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{r.last_salesperson ? firstName(r.last_salesperson) : "—"}</td>
                        <td className="py-2 pr-3 text-right text-gray-600">{r.avg_car_sales ?? "—"}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-purple-600">{r.attach_pct != null ? `${r.attach_pct}%` : "—"}</td>
                        <td className="py-2 text-gray-500 max-w-[220px]">
                          <span className="line-clamp-1" title={r.last_remark ?? undefined}>{r.last_remark ?? "—"}</span>
                        </td>
                      </tr>
                      {expandedDealer === r.dealer_name && (
                        <tr className="bg-orange-50/30">
                          <td colSpan={9} className="px-6 py-3">
                            {!histories[r.dealer_name] ? (
                              <div className="py-3 flex justify-center"><div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
                            ) : (
                              <div className="flex flex-col">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">
                                  Contact history ({histories[r.dealer_name].length})
                                </p>
                                {histories[r.dealer_name].map((c, i) => (
                                  <div key={i} className="flex items-start gap-3 py-1.5 border-b border-orange-100/50 last:border-0">
                                    <span className="text-[10px] text-gray-500 w-14 shrink-0 pt-0.5">{shortDate(c.visit_date)}</span>
                                    <ModeBadge mode={c.contact_mode} />
                                    <span className="text-[11px] font-semibold text-gray-600 w-24 shrink-0 truncate" title={c.salesperson ?? undefined}>
                                      {c.salesperson ? firstName(c.salesperson) : "—"}
                                    </span>
                                    <span className="text-[11px] text-gray-500 shrink-0 whitespace-nowrap">
                                      {[
                                        c.car_sales != null ? `${c.car_sales} cars` : null,
                                        c.seat_cover_sales != null ? `${c.seat_cover_sales} SC` : null,
                                        c.mats_sales != null ? `${c.mats_sales} mats` : null,
                                      ].filter(Boolean).join(" · ")}
                                    </span>
                                    <span className="text-[11px] text-gray-500 flex-1 min-w-0">{c.remarks ?? ""}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {dealers.length === 0 && (
                    <tr><td colSpan={9} className="py-6 text-center text-gray-500">No dealerships match these filters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={dirTotal} perPage={perPage} onPage={setPage} />
          </>
        )}
      </div>

      {/* Attach rate by OEM */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Seat-Cover Attach Rate by OEM</h3>
        <p className="text-[10px] text-gray-500 mb-3">
          Seat-cover sales as a share of each dealer's own car sales, averaged per dealer first — how deep we are in
          each OEM's network, all time.
        </p>
        <div className="flex flex-col gap-2">
          {(attach?.by_oem ?? []).map((r) => (
            <div key={r.oem} className="flex items-center gap-3">
              <span className="text-xs font-semibold text-gray-600 w-24 shrink-0 truncate" title={r.oem}>{r.oem}</span>
              <div className="flex-1 h-5 bg-gray-50 rounded-md overflow-hidden">
                <div className="h-full rounded-md" title={r.mats_attach_pct != null ? `Mats attach: ${r.mats_attach_pct}%` : undefined}
                  style={{ width: `${Math.min(((r.attach_pct ?? 0) / attachMax) * 100, 100)}%`, background: "#a855f7" }} />
              </div>
              <span className="text-xs font-bold text-purple-600 w-14 text-right">{r.attach_pct != null ? `${r.attach_pct}%` : "—"}</span>
              <span className="text-[10px] text-gray-500 w-20 text-right shrink-0">{r.dealers} dealer{r.dealers === 1 ? "" : "s"}</span>
            </div>
          ))}
          {(attach?.by_oem ?? []).length === 0 && <p className="text-xs text-gray-500">No dealer-reported figures yet</p>}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Remarks tab — remark themes, per-salesperson rollup, full field log
// ══════════════════════════════════════════════════════════════════════════════

/** A theme tag as it appears in the feed and rollup cards. */
function ThemeChip({ themeKey, count }: { themeKey: string; count?: number }) {
  const m = themeMeta(themeKey);
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ color: m.color, background: m.bg }}>
      {m.label}{count != null && <span className="opacity-70">{count}</span>}
    </span>
  );
}

/** The category the rep themselves chose, as a chip. */
function CategoryChip({ categoryKey, label }: { categoryKey: string; label: string }) {
  const m = categoryMeta(categoryKey);
  return (
    <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
      style={{ color: m.color, background: m.bg }}>
      {label}
    </span>
  );
}

/** The primary filter surface: one column per remark category, with the keyword
 *  themes nested underneath it. The rep hand-classifies every note on the form,
 *  so the category is the trustworthy axis and the themes only add detail
 *  *within* it ("of the 161 Sales notes, 67 are chasing an order").
 *  Clicking a category scopes the feed; clicking a nested theme scopes to that
 *  theme inside that category. */
function CategoryPanel({ categories, activeCategory, activeTheme, onPick }: {
  categories: RemarkCategory[];
  activeCategory: string; activeTheme: string;
  onPick: (category: string, theme: string) => void;
}) {
  if (!categories.length) return <p className="text-xs text-gray-500 py-2">No remarks in this slice.</p>;
  const total = categories.reduce((s, c) => s + c.count, 0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
      {categories.map((c) => {
        const m = categoryMeta(c.key);
        const on = activeCategory === c.key;
        const share = total ? Math.round((c.count / total) * 100) : 0;
        return (
          <div key={c.key} className="rounded-xl border transition-all"
            style={{ borderColor: on ? m.color : "#f1f0ee", background: on ? m.bg : "#fff" }}>
            <button onClick={() => onPick(on && !activeTheme ? "" : c.key, "")}
              className="w-full text-left px-3 pt-2.5 pb-2"
              title={`${c.count} note${c.count === 1 ? "" : "s"} — click to ${on && !activeTheme ? "clear" : "filter"}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold" style={{ color: m.color }}>{c.label}</span>
                <span className="text-[10px] text-gray-500">{share}%</span>
              </div>
              <p className="text-xl font-black leading-tight" style={{ color: m.color }}>{c.count}</p>
              <div className="h-1 rounded-full mt-1.5 overflow-hidden" style={{ background: "#f1f0ee" }}>
                <div className="h-full rounded-full" style={{ width: `${share}%`, background: m.color }} />
              </div>
            </button>
            {c.themes.length > 0 && (
              <div className="flex flex-col px-2 pb-2 pt-0.5 gap-0.5">
                {c.themes.slice(0, 5).map((t) => {
                  const tm = themeMeta(t.key);
                  const tOn = on && activeTheme === t.key;
                  return (
                    <button key={t.key} onClick={() => onPick(c.key, tOn ? "" : t.key)}
                      className="flex items-center justify-between gap-2 px-1.5 py-0.5 rounded-md hover:bg-white/70 transition-colors"
                      style={tOn ? { background: tm.bg } : undefined}
                      title={`${t.count} ${c.label} note${t.count === 1 ? "" : "s"} tagged ${tm.label}`}>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="w-1 h-1 rounded-full shrink-0" style={{ background: tm.color }} />
                        <span className="text-[10px] truncate" style={{ color: tOn ? tm.color : "#6b7280" }}>{tm.label}</span>
                      </span>
                      <span className="text-[10px] font-bold shrink-0" style={{ color: tOn ? tm.color : "#9ca3af" }}>{t.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One field person's card — activity counts and what they're mostly doing
 *  (top themes). Clicking scopes the whole tab to them. */
function PersonCard({ p, active, onPick }: {
  p: PersonRollup; active: boolean; onPick: () => void;
}) {
  return (
    <button onClick={onPick}
      className={`text-left bg-white border rounded-2xl p-4 shadow-sm transition-all hover:border-orange-200 ${
        active ? "border-orange-300 ring-2 ring-orange-100" : "border-orange-100"
      }`}>
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-100 to-orange-50 text-brand-orange flex items-center justify-center font-black text-sm shrink-0">
          {(p.salesperson[0] || "?").toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-gray-800 truncate" title={p.salesperson}>{p.salesperson}</p>
          <p className="text-[10px] text-gray-500">
            <b className="text-gray-600">{p.remarks}</b> notes · {p.dealers} dealer{p.dealers === 1 ? "" : "s"}
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className="text-[10px] font-bold" style={{ color: VISIT_COLOR }}>{p.visits}V</span>
          <span className="text-[10px] font-bold text-gray-500"> · </span>
          <span className="text-[10px] font-bold" style={{ color: CALL_COLOR }}>{p.calls}C</span>
        </div>
      </div>

      {/* Category mix first — it's what the rep actually declared they were
          doing; the themes below are the inferred detail. */}
      {p.categories.length > 0 && (
        <div className="flex h-1.5 rounded-full overflow-hidden mt-3" title={p.categories.map((c) => `${c.label}: ${c.count}`).join(" · ")}>
          {p.categories.map((c) => (
            <div key={c.key} style={{
              flexGrow: c.count,
              background: categoryMeta(c.key).color,
            }} />
          ))}
        </div>
      )}
      {p.categories.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {p.categories.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md"
              style={{ color: categoryMeta(c.key).color, background: categoryMeta(c.key).bg }}>
              {c.label}<span className="opacity-70">{c.count}</span>
            </span>
          ))}
        </div>
      )}
      {p.top_themes.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.top_themes.map((t) => <ThemeChip key={t.key} themeKey={t.key} count={t.count} />)}
        </div>
      )}
    </button>
  );
}

function FieldActivityTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson: scopeName } = useOEScope();
  const period = usePeriod("monthly");
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[]; contact_modes: string[] } | null>(null);

  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [mode, setMode] = useState("");
  const [category, setCategory] = useState("");
  const [theme, setTheme] = useState("");
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<RemarksData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const { syncing, syncAll } = useSyncLatest(headers, () => setRefreshKey((k) => k + 1), ["log"]);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/periods`, { headers }),
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        // Only the months that actually have logs — this tab reads the log book.
        const p = await perRes.json();
        period.setMonths(p.log_months);
        if (!p.log_months.length) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Land on the newest month that has logs, once the lists are built.
  useEffect(() => {
    if (!period.token && period.options.length) period.setToken(period.options[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.options]);

  // Any change to the slice resets to the first page of the feed.
  useEffect(() => { setPage(1); }, [period.token, period.mode, period.range, salesperson, oem, state, city, mode, category, theme, qDeb]);

  useEffect(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    if (!pp) return;
    const params = new URLSearchParams({ ...pp, page: String(page), per_page: "30" });
    if (salesperson) params.set("salesperson", salesperson);
    if (oem) params.set("oem", oem);
    if (state) params.set("state", state);
    if (city) params.set("city", city);
    if (mode) params.set("contact_mode", mode);
    if (category) params.set("category", category);
    if (theme) params.set("theme", theme);
    if (qDeb) params.set("q", qDeb);
    // Abort on supersede — this tab filters on eight things plus a debounced
    // search, so out-of-order responses are easy to provoke.
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/remarks?${params}`,
          { headers, signal: ctrl.signal });
        if (res.ok) setData(await res.json());
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.token, period.mode, period.range, salesperson, oem, state, city, mode, category, theme, qDeb, page, refreshKey]);

  const hasFilters = Boolean(salesperson || oem || state || city || mode || category || theme || q);
  const clearFilters = () => {
    setSalesperson(""); setOem(""); setState(""); setCity(""); setMode("");
    setCategory(""); setTheme(""); setQ("");
  };
  const categoryLabel = (key: string) =>
    data?.categories.find((c) => c.key === key)?.label ?? key;

  if (!loading && period.months.length === 0) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
        {scoped
          ? <>No log book entries under <b>{scopeName}</b> yet. Your remarks and field
              activity appear here once your visits are synced.</>
          : <>No log book data yet — register and sync the log book from the <b>Data Source Sheets</b> tab.</>}
      </div>
    );
  }

  const feed = data?.feed.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        {!scoped && (
          <Select value={salesperson} onChange={setSalesperson}
            options={filterOpts(options?.salespersons, "salesperson")}
            placeholder={FILTER_LABELS.salesperson.placeholder} />
        )}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={state} onChange={setState} options={filterOpts(options?.states, "state")}
          placeholder={FILTER_LABELS.state.placeholder} />
        <Select value={city} onChange={setCity} options={filterOpts(options?.cities, "city")}
          placeholder={FILTER_LABELS.city.placeholder} />
        <Select value={mode} onChange={setMode} options={filterOpts(options?.contact_modes, "mode")}
          placeholder={FILTER_LABELS.mode.placeholder} />
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search remark or dealer…"
            className={`${inputClass} pl-8 w-44`} />
        </div>
        <ClearFilters show={hasFilters} onClear={clearFilters} />
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefreshKey((k) => k + 1)} disabled={loading} />
          <SyncButton onClick={syncAll} syncing={syncing}
            title="Re-pull the log book from Google Sheets" />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      {scoped && scopeName && <ScopeNote salesperson={scopeName} />}

      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          Remarks · {period.options.find((o) => o.value === period.token)?.label ?? ""}
          {salesperson && ` · ${salesperson}`}{oem && ` · ${oem}`}
          {category && ` · ${categoryLabel(category)}`}{theme && ` · ${themeMeta(theme).label}`}
          {qDeb && ` · “${qDeb}”`}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Remarks" value={data?.kpis.remarks ?? 0}
          sub={data && data.kpis.notes > data.kpis.remarks
            ? `${data.kpis.notes.toLocaleString("en-IN")} notes across categories`
            : "field notes logged"}
          icon={<MessageSquare size={18} />} {...KPI.ours} />
        <StatCard label="Dealers Touched" value={data?.kpis.dealers ?? 0}
          icon={<Building2 size={18} />} {...KPI.reach} />
        {/* Grey, not purple: purple is reserved for a target nobody owns, and a
            headcount of people is the one thing it must never look like. */}
        <StatCard label="People Active" value={data?.kpis.salespersons ?? 0}
          icon={<Users size={18} />} {...KPI.neutral} />
        <StatCard label="Visits" value={data?.kpis.visits ?? 0}
          icon={<Footprints size={18} />} {...KPI.visits} />
        <StatCard label="Calls" value={data?.kpis.calls ?? 0}
          icon={<Phone size={18} />} {...KPI.calls} />
      </div>

      {/* What's being reported — theme filter row */}
      <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
              <Tag size={13} /> What the field is reporting
            </h3>
            <p className="text-[10px] text-gray-500">
              Grouped by the category the rep chose on the form, then auto-tagged within it. Click a category — or a
              tag inside one — to filter the log below.
            </p>
          </div>
          {(category || theme) && (
            <button onClick={() => { setCategory(""); setTheme(""); }}
              className="flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-red-500">
              <X size={12} /> Clear
              {category && ` ${categoryLabel(category)}`}{theme && ` · ${themeMeta(theme).label}`}
            </button>
          )}
        </div>
        <CategoryPanel categories={data?.categories ?? []} activeCategory={category} activeTheme={theme}
          onPick={(c, t) => { setCategory(c); setTheme(t); }} />
      </div>

      {/* Per-salesperson rollup — "what is everyone up to" */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Salesperson — click to focus</h3>
          {salesperson && (
            <button onClick={() => setSalesperson("")}
              className="flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-red-500">
              <X size={12} /> Show everyone
            </button>
          )}
        </div>
        {(data?.by_salesperson ?? []).length === 0 ? (
          <div className="bg-white border border-orange-100 rounded-2xl p-8 text-center text-xs text-gray-500">
            No remarks for this selection.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(data?.by_salesperson ?? []).map((p) => (
              <PersonCard key={p.salesperson} p={p} active={salesperson === p.salesperson}
                onPick={() => setSalesperson(salesperson === p.salesperson ? "" : p.salesperson)} />
            ))}
          </div>
        )}
      </div>

      {/* Full field log */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <MessageSquare size={13} /> Field Log
            {category && <CategoryChip categoryKey={category} label={categoryLabel(category)} />}
            {theme && <ThemeChip themeKey={theme} />}
          </h3>
          <p className="text-[10px] text-gray-500">{data?.feed.total.toLocaleString("en-IN") ?? 0} remarks</p>
        </div>

        <div className="flex flex-col divide-y divide-gray-50">
          {feed.map((r) => (
            <div key={r.id} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:w-40 shrink-0">
                <span className="text-[10px] text-gray-500 w-12 shrink-0">{shortDate(r.visit_date)}</span>
                <ModeBadge mode={r.contact_mode} />
              </div>
              <div className="sm:w-36 shrink-0 min-w-0">
                <p className="text-xs font-semibold text-gray-700 truncate" title={r.dealership ?? undefined}>{r.dealership ?? "—"}</p>
                <p className="text-[10px] text-gray-500 truncate">
                  {r.salesperson ? firstName(r.salesperson) : "—"}{r.oem && ` · ${r.oem}`}
                </p>
              </div>
              {/* One block per category the rep wrote in. When a category is
                  being filtered on, the others stay visible but dimmed — the
                  matching note is the point, the rest is context for it. */}
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                {r.notes.map((n, i) => {
                  const dim = Boolean(category) && n.category !== category;
                  return (
                    <div key={`${n.category}-${i}`} className={dim ? "opacity-40" : undefined}>
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 mt-px"><CategoryChip categoryKey={n.category} label={n.label} /></span>
                        <p className="text-[13px] text-gray-700 leading-snug min-w-0">{n.text}</p>
                      </div>
                      {n.themes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1 ml-1">
                          {n.themes.map((t) => <ThemeChip key={t} themeKey={t} />)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {feed.length === 0 && !loading && (
            <p className="py-8 text-center text-xs text-gray-500">No remarks match these filters.</p>
          )}
        </div>

        {data && (
          <Pagination page={data.feed.page} total={data.feed.total} perPage={data.feed.per_page} onPage={setPage} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Targets tab — quarterly target vs achievement
// ══════════════════════════════════════════════════════════════════════════════
/** Units or money out of the same row — the API sends both. */
function pick(r: TgtMetrics, m: Metric) {
  return m === "value"
    ? { tgt: r.tgt_value, ach: r.ach_value, pct: r.ach_pct_value }
    : { tgt: r.tgt_nos, ach: r.ach_nos, pct: r.ach_pct_nos };
}

const fmtNos = (n: number) => Math.round(n).toLocaleString("en-IN");
const fmtBy = (m: Metric) => (m === "value" ? formatCompact : fmtNos);

/**
 * Target-vs-achievement bullet rows for the salesperson Targets tab. The chart
 * itself is BulletChart in ./oe-network/shared — shared with the OEM Targets
 * tab so "how far along a goal is" can only look one way in this module. This
 * is the adapter that turns a TgtGroup into its rows.
 *
 * `unattributed` is for the charts that group by a person or their region: the
 * MSIL/TATA accessories lines belong to no salesperson, so they cannot be a bar
 * among the others, but leaving them out entirely would make the chart add up to
 * less than the KPI above it with nothing on screen to explain the difference.
 * They get their own row below the rule instead, in their own colour.
 */
function TargetBulletChart({
  rows, metric, unattributed,
}: {
  rows: TgtGroup[];
  metric: Metric;
  unattributed?: (TgtMetrics & { oems: string[] }) | null;
}) {
  const fmt = fmtBy(metric);
  const data: BulletDatum[] = [
    ...rows.map((r) => ({ key: r.key, sub: r.region, ...pick(r, metric) })),
    ...(unattributed
      ? [{
          key: "Accessories",
          sub: `${unattributed.oems.join(", ")} · no salesperson`,
          ...pick(unattributed, metric),
          unowned: true,
        }]
      : []),
  ];
  return (
    <BulletChart rows={data} fmt={fmt}
      legendExtra={unattributed ? (
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: UNOWNED_COLOR }} />
          Accessories — an OEM product line, not anybody's number
        </span>
      ) : undefined} />
  );
}

function TargetsTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson: scopeName } = useOEScope();
  const [periods, setPeriods] = useState<TgtPeriod[]>([]);
  // The same five presets as every other tab. Targets are published per quarter,
  // but they are STORED one row per month, so a month/FY/day selection is just
  // as answerable — and having this tab alone offer a different set of period
  // controls was the single biggest inconsistency left in the module.
  const period = usePeriod("monthly");
  const [options, setOptions] = useState<{ oems: string[]; categories: string[]; salespersons: string[]; regions: string[] } | null>(null);
  const [metric, setMetric] = useState<Metric>("value");
  const [oem, setOem] = useState("");
  const [category, setCategory] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [region, setRegion] = useState("");
  const [data, setData] = useState<TgtSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { syncing, syncAll } = useSyncLatest(headers, () => setRefreshKey((k) => k + 1), ["targets"]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/targets/periods`, { headers }),
        fetch(`${API_URL}/oe-network/targets/filter-options`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        const p: TgtPeriod[] = await perRes.json();
        setPeriods(p);
        // Recomputed every time, not latched: registering the first target
        // sheet and hitting Refresh has to be able to clear this state without
        // a remount, which only happened by luck when switching tabs.
        setEmpty(p.length === 0);
        // The period picker offers exactly the months a registered quarter
        // covers, so no preset can select a period that must come back empty.
        const months = p.flatMap((q) => (QUARTER_MONTHS[q.quarter] ?? []).map((m) => ({
          year: m >= 4 ? q.fy_year : q.fy_year + 1, month: m,
        })));
        period.setMonths(months);
        if (!p.length) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Land on the newest month that actually holds targets, once the list arrives.
  useEffect(() => {
    if (!period.token && period.options.length) period.setToken(period.options[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.options]);

  useEffect(() => {
    // Targets are stored per month inside their quarter, so every preset —
    // month, quarter, FY, day range — reduces to whole months server-side.
    // A range covering Apr–Jun reads identically to picking Q1.
    const pp = periodParams(period.mode, period.token, period.range);
    // Half a custom range is not a question we can ask. Drop what's on screen
    // rather than leaving the previous period's numbers sitting under a period
    // the user is still typing — they read as that period's answer.
    if (!pp) { setData(null); setLoading(false); return; }
    const params = new URLSearchParams(pp);
    if (oem) params.set("oem", oem);
    if (category) params.set("category", category);
    if (salesperson) params.set("salesperson", salesperson);
    if (region) params.set("region", region);
    // Abort on supersede, like every other tab.
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/targets/summary?${params}`,
          { headers, signal: ctrl.signal });
        setData(res.ok ? await res.json() : null);
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.mode, period.token, period.range, oem, category, salesperson, region, refreshKey]);

  const activeFilters = [
    oem && `OEM ${oem}`,
    category && categoryLabel(category),
    salesperson && salesperson,
    region && `region ${region}`,
  ].filter(Boolean) as string[];
  const hasFilters = activeFilters.length > 0;
  const clearFilters = () => { setOem(""); setCategory(""); setSalesperson(""); setRegion(""); };
  // A custom range the user is still filling in — a real state, not an empty result.
  const rangeIncomplete = period.mode === "custom" && !(period.range.from && period.range.to);
  const fmt = fmtBy(metric);
  const k = data?.kpis;
  const kv = k ? pick(k, metric) : null;

  // A crore-scaled block can only express ₹0.01 Cr, i.e. ₹1 lakh — worth saying
  // out loud when someone reconciles a total against the sheet to the rupee.
  const croreOems = Object.entries(data?.value_scales ?? {})
    .filter(([, s]) => s === "crores").map(([o]) => o);

  if (empty) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
        {scoped
          ? <>No targets are booked against <b>{scopeName}</b> for any quarter on record.
              Targets the OE sheet files under a product rather than a person — the MSIL
              and TATA accessory lines — belong to nobody and are not shown here.</>
          : <>No target data yet — register a quarter&rsquo;s target sheet from the <b>Data Source Sheets</b> tab.</>}
      </div>
    );
  }

  // An empty result never gets its own screen: it used to return early with a
  // stripped-down bar, which took away the very date inputs and filter
  // dropdowns needed to get back out of it. The filters always stay put and
  // only the body below them changes.

  const monthChart = (data?.by_month ?? []).map((m) => {
    const v = pick(m, metric);
    return { name: `${MONTH_SHORT[m.month - 1]} ${String(m.year).slice(2)}`, Target: v.tgt, Achieved: v.ach };
  });

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
          {(["value", "nos"] as Metric[]).map((m) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
                metric === m ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {m === "value" ? "Value" : "Units"}
            </button>
          ))}
        </div>
        {/* Person first, then OEM — the same order as every other tab. */}
        {!scoped && (
          <Select value={salesperson} onChange={setSalesperson}
            options={filterOpts(options?.salespersons, "salesperson")}
            placeholder={FILTER_LABELS.salesperson.placeholder} />
        )}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={region} onChange={setRegion} options={filterOpts(options?.regions, "region")}
          placeholder={FILTER_LABELS.region.placeholder} />
        {/* Product carries its own labels, so it can't use filterOpts. */}
        <Select value={category} onChange={setCategory}
          options={[{ value: "", label: FILTER_LABELS.product.all },
                    ...(options?.categories ?? []).map((c) => ({ value: c, label: categoryLabel(c) }))]}
          placeholder={FILTER_LABELS.product.placeholder} />
        <ClearFilters show={hasFilters} onClear={clearFilters} />
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefreshKey((k) => k + 1)} disabled={loading} />
          <SyncButton onClick={syncAll} syncing={syncing}
            title="Re-pull the latest quarter's target sheet from Google Sheets" />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      {scoped && scopeName && (
        <ScopeNote salesperson={scopeName}>
          Targets booked against no individual — the MSIL and TATA accessory
          lines — are not counted here, so this total is smaller than the team
          sheet&rsquo;s.
        </ScopeNote>
      )}

      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          Target vs Achievement · {data?.label ?? ""} · {metric === "value" ? "Value" : "Units"}
          {oem && ` · ${oem}`}{category && ` · ${category}`}{salesperson && ` · ${salesperson}`}{region && ` · ${region}`}
        </p>
      </div>

      {!data && !loading ? (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
          {rangeIncomplete ? (
            "Pick a start and an end date to read targets across a custom period."
          ) : (
            <>
              <p className="text-sm font-semibold text-gray-500 mb-1.5">
                {period.mode === "custom"
                  ? `No targets for ${shortDate(period.range.from)} – ${shortDate(period.range.to)}`
                  : "No targets match this selection"}
              </p>
              {/* Two different causes, and the wrong guess sends someone editing
                  dates when a filter is what emptied the screen. Name both. */}
              <p>
                Targets are published per quarter, and only{" "}
                <b className="text-gray-600">{periods.map((p) => p.label).join(", ") || "—"}</b>{" "}
                {periods.length === 1 ? "has" : "have"} been registered.
              </p>
              {hasFilters && (
                <p className="mt-1.5">
                  The <b className="text-gray-600">{activeFilters.join(" + ")}</b>{" "}
                  filter{activeFilters.length > 1 ? "s" : ""} may be excluding everything —{" "}
                  <button onClick={clearFilters}
                    className="font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                    clear {activeFilters.length > 1 ? "them" : "it"}
                  </button>{" "}
                  to check.
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={metric === "value" ? "Target Value" : "Target Units"}
              value={kv ? fmt(kv.tgt) : "—"} icon={<Target size={18} />} {...KPI.target} />
            <StatCard label={metric === "value" ? "Achieved Value" : "Achieved Units"}
              value={kv ? fmt(kv.ach) : "—"} icon={<TrendingUp size={18} />} {...KPI.ours} />
            <StatCard label="Achievement" value={kv?.pct != null ? `${kv.pct}%` : "—"}
              sub={metric === "value" ? "on value" : "on units"}
              icon={<Percent size={18} />}
              {...((kv?.pct ?? 0) >= ON_TRACK_PCT ? KPI.conversion : KPI.warning)} />
            <StatCard label="Gap"
              value={kv ? `${kv.ach - kv.tgt >= 0 ? "+" : "−"}${fmt(Math.abs(kv.ach - kv.tgt))}` : "—"}
              sub={kv && kv.ach >= kv.tgt ? "ahead of target" : "short of target"}
              icon={<Building2 size={18} />}
              {...(kv && kv.ach >= kv.tgt ? KPI.conversion : KPI.danger)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Salesperson</h3>
              <p className="text-[10px] text-gray-500 mb-1">
                Ranked by target size
                {data?.unattributed && " · the last row is not a person — see the note below"}
              </p>
              <TargetBulletChart rows={data?.by_salesperson ?? []} metric={metric}
                unattributed={data?.unattributed} />
            </div>

            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By OEM</h3>
              <p className="text-[10px] text-gray-500 mb-1">All of an OEM's products clubbed together — use the Product filter to split seat covers, mats and accessories</p>
              <TargetBulletChart rows={data?.by_oem ?? []} metric={metric} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Month by Month</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthChart} margin={{ top: 18, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false} interval={0} />
                  <YAxis tick={{ fontSize: 10, fill: CHART_LABEL }} axisLine={false} tickLine={false}
                    tickFormatter={(v: number) => (metric === "value" ? formatCompactNos(v) : fmtNos(v))} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }}
                    itemStyle={{ color: CHART_LABEL }} formatter={(v: number) => fmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }}
                    formatter={(value: string) => <span style={{ color: CHART_LABEL }}>{value}</span>} />
                  <Bar dataKey="Target" fill={NEUTRAL_BAR} radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="Target" position="top" fill="#9ca3af" fontSize={9} fontWeight={700}
                      formatter={(v: number) => fmt(v)} />
                  </Bar>
                  <Bar dataKey="Achieved" fill={VISIT_COLOR} radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="Achieved" position="top" fill="#6b7280" fontSize={9} fontWeight={700}
                      formatter={(v: number) => fmt(v)} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Region</h3>
              <p className="text-[10px] text-gray-500 mb-1">
                Regions come from the sheet's own "NAME- REGION" column, so an OEM that
                writes a territory differently gets its own row
              </p>
              <TargetBulletChart rows={data?.by_region ?? []} metric={metric}
                unattributed={data?.unattributed} />
            </div>
          </div>

          {/* Product split — the detail behind the clubbed OEM view */}
          <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">OEM × Product</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right">Target</th>
                    <th className="py-2 pr-3 text-right">Achieved</th>
                    <th className="py-2 pr-3 text-right">Gap</th>
                    <th className="py-2 text-right">Achievement</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.by_oem_category ?? []).map((r, i) => {
                    const v = pick(r, metric);
                    return (
                      <tr key={i} className="border-b border-gray-50 hover:bg-orange-50/40">
                        <td className="py-2 pr-3 font-semibold text-gray-700">{r.oem}</td>
                        <td className="py-2 pr-3 text-gray-500">{categoryLabel(r.key)}</td>
                        <td className="py-2 pr-3 text-right text-gray-600">{fmt(v.tgt)}</td>
                        <td className="py-2 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{fmt(v.ach)}</td>
                        <td className={`py-2 pr-3 text-right font-semibold ${v.ach >= v.tgt ? "text-green-600" : "text-red-500"}`}>
                          {v.ach - v.tgt >= 0 ? "+" : "−"}{fmt(Math.abs(v.ach - v.tgt))}
                        </td>
                        <td className={`py-2 text-right font-bold ${achColor(v.pct)}`}>
                          {v.pct != null ? `${v.pct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data?.unattributed && (
              <p className="text-[10px] text-gray-500 mt-3">
                <b className="text-violet-600">Accessories</b> for {data.unattributed.oems.join(" and ")} are
                agreed as one number for the OEM and are not split between salespeople, so they carry no name
                and no region. They are counted in the KPIs, in <i>By OEM</i> and in <i>Month by Month</i>; in{" "}
                <i>By Salesperson</i> and <i>By Region</i> they sit on their own row below the rule, which is
                why those bars add up to less than the headline on their own.
                {(data.by_oem_category ?? []).some((r) => r.key === "ACC" && !data.unattributed?.oems.includes(r.oem))
                  && " Other OEMs do split accessories by salesperson, and those rows behave like any other."}
              </p>
            )}
            {croreOems.length > 0 && metric === "value" && (
              <p className="text-[10px] text-gray-500 mt-3">
                {croreOems.join(", ")} are entered in the source sheet in crores to two decimals, so their money
                figures carry a ±₹1 lakh rounding per cell. Unit counts are exact.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Sheets tab — registry + sync for all three sheet types
// ══════════════════════════════════════════════════════════════════════════════
interface HistoryItem {
  id: string; sheet_type: string; source_label: string; rows_total: number;
  rows_inserted: number; rows_failed: number; rows_deleted: number;
  status: string; synced_at: string | null;
}

// Named after the TAB each sheet fills, not the sheet's own title. The team
// adding a sheet thinks "the Dealers tab is empty", not "the dealership view
// file is missing" — sheet-centric names meant they had to ask every time.
const SHEET_TYPE_LABELS: Record<string, string> = {
  visit_plan: "Visit/Calling — Visit Plan", log_book: "Visit/Calling — Log Book",
  targets: "Salesperson Targets", dealer_data: "Dealers", oem_target: "OEM Targets",
};

function SourceCardHead({ tab, sheet, note, action }: {
  tab: string; sheet: string; note: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-2 mb-2">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-bold text-gray-800">{tab}</h3>
        <p className="text-[11px] text-gray-600 mt-0.5">
          Sheet to add: <span className="font-semibold text-gray-700">{sheet}</span>
        </p>
        <p className="text-[10px] text-gray-500 mt-0.5">{note}</p>
      </div>
      {action}
    </div>
  );
}

// Monthly plans, quarterly targets and yearly summaries pile up, and only the
// newest few are ever re-synced. The API returns each type newest first, so the
// head of the list is what people come here for; the rest folds away.
const SOURCES_VISIBLE = 3;

function SourceList({ items, row, empty }: {
  items: OESource[]; row: (s: OESource) => ReactNode; empty: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return <p className="text-xs text-gray-500 py-3">{empty}</p>;
  const hidden = items.length - SOURCES_VISIBLE;
  return (
    <>
      {(open ? items : items.slice(0, SOURCES_VISIBLE)).map(row)}
      {hidden > 0 && (
        <button onClick={() => setOpen(!open)}
          className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-gray-600 hover:text-brand-orange">
          <ChevronRight size={12} className={`transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
          {open ? "Show fewer" : `Show ${hidden} older`}
        </button>
      )}
    </>
  );
}

function SheetsTab({ headers }: { headers: Record<string, string> }) {
  const toast = useToast();
  const [sources, setSources] = useState<OESource[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  // Add-form state — one form per sheet type
  const [showAddPlan, setShowAddPlan] = useState(false);
  const [planLink, setPlanLink] = useState("");
  const now = new Date();
  const [planMonth, setPlanMonth] = useState(String(now.getMonth() + 1));
  const [planYear, setPlanYear] = useState(String(now.getFullYear()));
  const [showAddLog, setShowAddLog] = useState(false);
  const [logLink, setLogLink] = useState("");
  const [showAddDd, setShowAddDd] = useState(false);
  const [ddLink, setDdLink] = useState("");
  const [showAddTgt, setShowAddTgt] = useState(false);
  const [tgtLink, setTgtLink] = useState("");
  const [showAddOemTgt, setShowAddOemTgt] = useState(false);
  const [oemTgtLink, setOemTgtLink] = useState("");
  // Default to the quarter and FY the current month sits in (Indian FY, Apr–Mar).
  const [tgtQuarter, setTgtQuarter] = useState(`Q${Math.floor(((now.getMonth() + 9) % 12) / 3) + 1}`);
  const [tgtFy, setTgtFy] = useState(String(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1));
  // The OEM summary is registered per FINANCIAL year, so it needs its own FY
  // picker rather than sharing the quarterly sheet's — registering one must
  // never move the other's selection.
  const [oemTgtFy, setOemTgtFy] = useState(String(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1));
  const [adding, setAdding] = useState(false);
  // Closed by default: it is a diagnostic, and the header line already says
  // whether the last run failed, which is the only thing usually wanted.
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadSources = useCallback(async () => {
    const res = await fetch(`${API_URL}/oe-network/sheet-sources`, { headers });
    if (res.ok) setSources(await res.json());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadHistory = useCallback(async () => {
    const res = await fetch(`${API_URL}/oe-network/sync-history`, { headers });
    if (res.ok) setHistory(await res.json());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadSources(); loadHistory(); }, [loadSources, loadHistory]);

  const handleSync = async (id: string) => {
    // Guards a double-click only. A reload mid-sync clears this state while the
    // server request is still in flight, so the real protection is the row lock
    // the sync endpoint takes — this just avoids the pointless 409.
    if (syncingId !== null) return;
    setSyncingId(id);
    setLastResult(null);
    try {
      const res = await fetch(`${API_URL}/oe-network/sheet-sources/${id}/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Sync failed");
      setLastResult(data);
      toast.success("Sync complete", `${data.rows_inserted} rows loaded${data.rows_deleted ? `, ${data.rows_deleted} old rows replaced` : ""}`);
    } catch (e) {
      toast.error("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingId(null);
      loadSources();
      loadHistory();
    }
  };

  const handleDelete = async (s: OESource) => {
    if (!window.confirm(`Remove "${s.label}" and all its synced data? This cannot be undone.`)) return;
    setDeletingId(s.id);
    try {
      const res = await fetch(`${API_URL}/oe-network/sheet-sources/${s.id}`, { method: "DELETE", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Delete failed");
      toast.success("Sheet removed", `${data.rows_deleted} data rows cleared`);
    } catch (e) {
      toast.error("Could not remove sheet", e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
      loadSources();
    }
  };

  const handleAdd = async (sheetType: OESource["sheet_type"]) => {
    const link = sheetType === "visit_plan" ? planLink
      : sheetType === "targets" ? tgtLink
      : sheetType === "dealer_data" ? ddLink
      : sheetType === "oem_target" ? oemTgtLink
      : logLink;
    if (!link.trim()) return;
    setAdding(true);
    try {
      const body: Record<string, unknown> = { sheet_url_or_id: link.trim(), sheet_type: sheetType };
      if (sheetType === "visit_plan") {
        body.month = Number(planMonth);
        body.year = Number(planYear);
      } else if (sheetType === "targets") {
        body.quarter = tgtQuarter;
        body.year = Number(tgtFy);   // FY start year
      } else if (sheetType === "oem_target") {
        body.year = Number(oemTgtFy);   // FY start year; no quarter, it is the whole year
      }
      const res = await fetch(`${API_URL}/oe-network/sheet-sources`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Could not add sheet");
      toast.success("Sheet registered", data.label);
      if (sheetType === "visit_plan") { setShowAddPlan(false); setPlanLink(""); }
      else if (sheetType === "targets") { setShowAddTgt(false); setTgtLink(""); }
      else if (sheetType === "dealer_data") { setShowAddDd(false); setDdLink(""); }
      else if (sheetType === "oem_target") { setShowAddOemTgt(false); setOemTgtLink(""); }
      else { setShowAddLog(false); setLogLink(""); }
      await loadSources();
      // First sync right away, like every other sheet module.
      await handleSync(data.id);
    } catch (e) {
      toast.error("Could not add sheet", e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const historyFailed = history.filter((h) => h.status === "Failed").length;
  const planSources = sources.filter((s) => s.sheet_type === "visit_plan");
  const logSources = sources.filter((s) => s.sheet_type === "log_book");
  const tgtSources = sources.filter((s) => s.sheet_type === "targets");
  const ddSources = sources.filter((s) => s.sheet_type === "dealer_data");
  const oemTgtSources = sources.filter((s) => s.sheet_type === "oem_target");

  const monthOptions = MONTH_FULL.map((m, i) => ({ value: String(i + 1), label: m }));
  const yearOptions = Array.from({ length: 4 }, (_, i) => now.getFullYear() - 2 + i)
    .map((y) => ({ value: String(y), label: String(y) }));
  const quarterOptions = [
    { value: "Q1", label: "Q1 — AMJ" }, { value: "Q2", label: "Q2 — JAS" },
    { value: "Q3", label: "Q3 — OND" }, { value: "Q4", label: "Q4 — JFM" },
  ];
  const fyOptions = Array.from({ length: 4 }, (_, i) => now.getFullYear() - 2 + i)
    .map((y) => ({ value: String(y), label: `FY${y % 100}-${(y + 1) % 100}` }));

  const statusIcon = (status: string | null) => {
    if (status === "Done") return <CheckCircle2 size={13} className="text-green-500" />;
    if (status === "Failed") return <XCircle size={13} className="text-red-500" />;
    if (status) return <Clock size={13} className="text-amber-500" />;
    return null;
  };

  const sourceRow = (s: OESource) => (
    <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-700 truncate">{s.label}</p>
        <p className="text-[10px] text-gray-500 flex items-center gap-1">
          {statusIcon(s.last_sync_status)}
          {s.last_synced_at ? `Last synced ${formatDate(s.last_synced_at)}` : "Never synced"}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={() => handleSync(s.id)} disabled={syncingId !== null}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-50 transition-all">
          {syncingId === s.id
            ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
            : <><RefreshCw size={11} /> Sync Now</>}
        </button>
        <button onClick={() => handleDelete(s)} disabled={deletingId === s.id}
          className="flex items-center text-gray-500 hover:text-red-500 p-1.5 rounded-lg border border-transparent hover:border-red-100 transition-all disabled:opacity-40">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Visit plan sheets */}
        <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <SourceCardHead tab="Visit/Calling" sheet="Advance Visit Plan (one per month)"
            note="Salesperson tabs are detected automatically. This is the planned side of plan vs actual."
            action={
              <button onClick={() => setShowAddPlan(!showAddPlan)}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-brand-orange px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all shrink-0">
                <Plus size={13} /> Add Month
              </button>
            } />
          <AnimatePresence>
            {showAddPlan && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex flex-col gap-2">
                  <input value={planLink} onChange={(e) => setPlanLink(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/…" className={inputClass} />
                  <div className="flex gap-2">
                    <Select value={planMonth} onChange={setPlanMonth} options={monthOptions} className="flex-1" />
                    <Select value={planYear} onChange={setPlanYear} options={yearOptions} />
                    <button onClick={() => handleAdd("visit_plan")} disabled={adding || !planLink.trim()}
                      className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                      {adding ? "Adding…" : "Add & Sync"}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <SourceList items={planSources} row={sourceRow}
            empty="No visit plan added yet — Visit/Calling has nothing to compare visits against until one is." />
        </div>

        {/* Log book */}
        <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <SourceCardHead tab="Visit/Calling · Remarks · My Visits" sheet="Log Book (Google Form responses)"
            note="Added once — new form entries arrive on every sync. This is the actual side of plan vs actual."
            action={logSources.length === 0 && (
              <button onClick={() => setShowAddLog(!showAddLog)}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-brand-orange px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all shrink-0">
                <Plus size={13} /> Add Sheet
              </button>
            )} />
          <AnimatePresence>
            {showAddLog && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex gap-2">
                  <input value={logLink} onChange={(e) => setLogLink(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/…" className={`${inputClass} flex-1`} />
                  <button onClick={() => handleAdd("log_book")} disabled={adding || !logLink.trim()}
                    className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                    {adding ? "Adding…" : "Add & Sync"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <SourceList items={logSources} row={sourceRow}
            empty="No log book added yet — Visit/Calling, Remarks and My Visits stay empty until it is." />
        </div>
      </div>

      {/* Dealer data — one workbook, a tab per OEM, no period to pick: the
          month columns are read off the header row, so a re-sync picks up a
          newly added month on its own. */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <SourceCardHead tab="Dealers" sheet="Dealership view file (one workbook, a tab per OEM)"
          note={<>Total &lt;OEM&gt;, YSASC and YS Sale per dealer per month, plus quarterly target
            and achievement columns. Added once — new months are picked up on re-sync.</>}
          action={
            <button onClick={() => setShowAddDd(!showAddDd)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-brand-orange px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all shrink-0 ml-auto">
              <Plus size={13} /> Add Sheet
            </button>
          } />
        <AnimatePresence>
          {showAddDd && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex gap-2">
                <input value={ddLink} onChange={(e) => setDdLink(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…" className={`${inputClass} flex-1`} />
                <button onClick={() => handleAdd("dealer_data")} disabled={adding || !ddLink.trim()}
                  className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                  {adding ? "Adding…" : "Add & Sync"}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <SourceList items={ddSources} row={sourceRow}
          empty="No dealership view file added yet — the Dealers tab stays empty until one is." />
      </div>

      {/* Quarterly targets */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <SourceCardHead tab="Salesperson Targets" sheet="Quarterly target sheet (one per quarter)"
          note="OEM blocks are found by their headers, and money in crores is converted automatically."
          action={
            <button onClick={() => setShowAddTgt(!showAddTgt)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-brand-orange px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all shrink-0">
              <Plus size={13} /> Add Quarter
            </button>
          } />
        <AnimatePresence>
          {showAddTgt && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex flex-col gap-2">
                <input value={tgtLink} onChange={(e) => setTgtLink(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…" className={inputClass} />
                <div className="flex gap-2">
                  <Select value={tgtQuarter} onChange={setTgtQuarter} options={quarterOptions} className="flex-1" />
                  <Select value={tgtFy} onChange={setTgtFy} options={fyOptions} />
                  <button onClick={() => handleAdd("targets")} disabled={adding || !tgtLink.trim()}
                    className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                    {adding ? "Adding…" : "Add & Sync"}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <SourceList items={tgtSources} row={sourceRow}
          empty="No quarterly target sheet added yet — the Salesperson Targets tab stays empty until one is." />
      </div>

      {/* OEM target summary — one workbook per FINANCIAL year, a tab per OEM.
          No quarter to pick: the whole year's targets are in it from day one
          and only the achievement columns fill in, so a re-sync is the normal
          way to pick up a new month. */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <SourceCardHead tab="OEM Targets" sheet="OEM Target Summary (one per financial year)"
          note={<>One tab per OEM, one row per product, twelve months of target and achievement.
            Columns are found by their headers and each money column&rsquo;s scale is detected on
            its own, because the file mixes rupees and crores within a tab.</>}
          action={
            <button onClick={() => setShowAddOemTgt(!showAddOemTgt)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-brand-orange px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all shrink-0 ml-auto">
              <Plus size={13} /> Add Year
            </button>
          } />
        <AnimatePresence>
          {showAddOemTgt && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex flex-col gap-2">
                <input value={oemTgtLink} onChange={(e) => setOemTgtLink(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…" className={inputClass} />
                <div className="flex gap-2">
                  <Select value={oemTgtFy} onChange={setOemTgtFy} options={fyOptions} className="flex-1" />
                  <button onClick={() => handleAdd("oem_target")} disabled={adding || !oemTgtLink.trim()}
                    className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                    {adding ? "Adding…" : "Add & Sync"}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <SourceList items={oemTgtSources} row={sourceRow}
          empty="No OEM Target Summary added yet — the OEM Targets tab stays empty until one is." />
      </div>

      {/* Last sync result */}
      {lastResult && (
        <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Last Sync Result</h3>
          <div className="flex flex-wrap gap-6 text-xs">
            <span><b className="text-gray-800">{lastResult.rows_total}</b> <span className="text-gray-500">rows read</span></span>
            <span><b className="text-green-600">{lastResult.rows_inserted}</b> <span className="text-gray-500">loaded</span></span>
            <span><b className="text-gray-600">{lastResult.rows_deleted}</b> <span className="text-gray-500">replaced</span></span>
            {lastResult.skipped_tabs.length > 0 && (
              <span className="text-gray-500">Skipped tabs: {lastResult.skipped_tabs.join(", ")}</span>
            )}
          </div>
          {lastResult.errors.length > 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-100 rounded-xl p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mb-1">Row notes</p>
              {lastResult.errors.map((e, i) => (
                <p key={i} className="text-[11px] text-amber-700">{e}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sync history */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <button onClick={() => setHistoryOpen(!historyOpen)}
          className="w-full flex items-center justify-between gap-3 text-left">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <History size={13} /> Sync History
          </span>
          <span className="flex items-center gap-2 text-[11px] text-gray-500 min-w-0">
            <span className="truncate">
              {history.length === 0 ? "No syncs yet"
                : <>Last run {history[0].synced_at ? formatDate(history[0].synced_at) : "—"}
                    {historyFailed > 0 && <span className="text-red-600 font-semibold"> · {historyFailed} failed</span>}</>}
            </span>
            <ChevronRight size={14} className={`shrink-0 transition-transform ${historyOpen ? "rotate-90" : ""}`} />
          </span>
        </button>
        {historyOpen && <div className="overflow-x-auto mt-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-3">Sheet</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3 text-right">Rows</th>
                <th className="py-2 pr-3 text-right">Replaced</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-gray-50">
                  <td className="py-2 pr-3 text-gray-700 font-medium">{h.source_label}</td>
                  <td className="py-2 pr-3 text-gray-500">{SHEET_TYPE_LABELS[h.sheet_type] ?? h.sheet_type}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{h.rows_inserted}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{h.rows_deleted}</td>
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-1">
                      {statusIcon(h.status)}
                      <span className="text-gray-600">{h.status}</span>
                    </span>
                  </td>
                  <td className="py-2 text-gray-500">{h.synced_at ? formatDate(h.synced_at) : "—"}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-gray-500">No syncs yet</td></tr>
              )}
            </tbody>
          </table>
        </div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Page shell
// ══════════════════════════════════════════════════════════════════════════════
// In-Depth is built but parked — add { id: "indepth", label: "In-Depth" } back
// here to show the tab again. Raw plan/log row listings were dropped on purpose:
// this page is for visualisation, and a flat filterable table is what the source
// spreadsheet already does better.
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Visit/Calling" },
  { id: "dealers", label: "Dealers" },
  { id: "activity", label: "Remarks" },
  // Two target tabs, and the labels have to say which is which: one is the
  // money split between PEOPLE (the quarterly sheets), the other the
  // commitment made to each BRAND (the FY summary). "Targets" on its own next
  // to "OEM Targets" reads as though one were a subset of the other.
  { id: "targets", label: "Salesperson Targets" },
  { id: "oemtargets", label: "OEM Targets" },
  { id: "myvisits", label: "My Visits" },
  { id: "sheets", label: "Data Source Sheets" },
];

const TAB_SUBTITLES: Record<TabId, string> = {
  overview: "Plan coverage and field activity",
  indepth: "Dealer network health, plan adherence and attach rates",
  dealers: "Where the opportunity is — coverage, penetration and each dealership's own story",
  activity: "What the team is up to — remark themes, per-person rollup and the field log",
  targets: "Quarterly target vs achievement by salesperson and OEM",
  oemtargets: "The financial year's target agreed with each brand, and where it stands",
  myvisits: "Every visit and call you have submitted, in full — and exportable",
  sheets: "Connect and sync the source Google Sheets",
};

export default function OENetworkPage() {
  const { token } = useAuth();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const { scoped } = useOEScope();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  // OEM Targets is a management view — the commitment made to each BRAND, with
  // no personal attribution in it at all. A rep has no row of their own in it,
  // so showing it would hand them the whole company's brand plan rather than a
  // slice of their own work. Hidden here AND refused by the API; the tab strip
  // is a convenience, not the control.
  const tabs = useMemo(
    () => TABS.filter((t) => (t.id === "sheets" || t.id === "oemtargets" ? !scoped
                            : t.id === "myvisits" ? scoped
                            : true)),
    [scoped]);

  // A scoped user sitting on the registry tab when their access changes
  // mid-session is moved back to Overview, rather than left on a tab whose
  // every request now 403s.
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab("overview");
  }, [tabs, activeTab]);

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Print-only header (the interactive chrome is hidden on paper) */}
      <div className="print-only mb-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-500">Amato · OE Network</div>
        <div className="text-xl font-bold text-gray-900 mt-0.5">{tabs.find((t) => t.id === activeTab)?.label}</div>
      </div>

      {/* Header */}
      {/* The title block must shrink (min-w-0 flex-1) and the tab strip must not
          (shrink-0), or a long subtitle pushes the tabs onto their own row —
          which is why the tab strip sat beside the title on Remarks and
          below it on Dealers. The subtitle truncates instead of moving them. */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="no-print flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0 flex-1">
          {/* flex-wrap, and no row gap: the tab labels here are long and vary
              ("Salesperson Targets", "Data Source Sheets"), so on a narrow
              window the title has to fall onto a second line — between the two
              spans, never inside one. */}
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-0">
            <span className="page-title-dark">OE NETWORK</span>
            <span className="page-title-orange">{tabs.find((t) => t.id === activeTab)?.label.toUpperCase()}</span>
          </h1>
          <div className="flex items-center gap-2 mt-1 min-w-0">
            <div className="w-8 h-0.5 bg-gray-800 rounded shrink-0" />
            <div className="w-4 h-0.5 rounded shrink-0" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500 truncate"
              title={TAB_SUBTITLES[activeTab]}>{TAB_SUBTITLES[activeTab]}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 shrink-0">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                activeTab === t.id ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </motion.div>

      {activeTab === "overview" && <OverviewTab headers={headers} />}
      {activeTab === "dealers" && <DealersTab headers={headers} />}
      {activeTab === "indepth" && <InDepthTab headers={headers} />}
      {activeTab === "activity" && <FieldActivityTab headers={headers} />}
      {activeTab === "targets" && <TargetsTab headers={headers} />}
      {activeTab === "oemtargets" && <OemTargetsTab headers={headers} />}
      {activeTab === "myvisits" && <MyVisitsTab headers={headers} />}
      {activeTab === "sheets" && <SheetsTab headers={headers} />}
    </div>
  );
}
