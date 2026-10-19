// Export — pieces both tabs share: the API types, formatting, and the one
// filter bar. The filter state lives on the page, above the tabs, so switching
// from the pipeline to the lead list keeps the same slice of leads: the two
// endpoints take identical filters, and a figure on one tab must always match
// the rows on the other.
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import Select from "@/components/ui/Select";
import {
  FilterBar, FilterActions, ClearFilters, FilterSpinner, RefreshButton, SyncButton, PdfButton,
  FilterOverflow, FILTER_LABELS, filterOpts, toOpts,
} from "@/components/ui/FilterBar";
import { formatDate } from "@/lib/format";

import { KPI, NEUTRAL_BAR, FUNNEL_MISSED } from "../oe-network/shared";

export {
  API_URL, StatCard, KPI, VISIT_COLOR, CALL_COLOR, NEUTRAL_BAR, TGT_TRACK, CHART_LABEL,
  PeriodControls, usePeriod, periodParams,
} from "../oe-network/shared";

// ── API shapes ────────────────────────────────────────────────────────────────

/** A potential total and how many leads it covers — they always travel
 *  together, because most leads carry no estimate. */
export interface Pot { potential_cr: number | null; potential_count: number; leads: number }
export interface Group { key: string | null; leads: number; open: number; won: number; lost: number; pipeline: Pot }
export interface FunnelRow {
  stage: number; name: string; open_here: number; reached: number; pipeline: Pot;
  median_days_in_stage: number | null; days_known: number;
}
/** How a time-in-stage was measured — see services/export_leads_sync.stage_entry.
 *  `floor` is a lower bound (tracking began after the lead reached the stage)
 *  and is always printed with "≥". */
export type StageBasis = "observed" | "floor" | null;
export const BASIS_NOTE: Record<Exclude<StageBasis, null>, string> = {
  observed: "Seen by the sync moving into this stage",
  floor: "At this stage since tracking began at least — the real figure is longer",
};
export const fmtDays = (d: number | null, basis: StageBasis) =>
  d == null ? "—" : `${basis === "floor" ? "≥" : ""}${d}d`;

export interface AttentionItem {
  company: string; owner: string | null; region: string | null;
  stage_no: number | null; stage_name: string | null;
  days_in_stage: number | null; days_in_stage_basis: StageBasis; days_since_contact: number | null;
  next_action: string | null; next_action_date: string | null; target_close_date: string | null;
}
// ── Lead health (services/export_health.py) ──
export type HealthLevel = "critical" | "at_risk" | "watch" | "on_track" | "parked" | "unknown";
export type Clock = "stage" | "contact" | "next_action" | "target";
export interface HealthReason {
  clock: Clock; level: "critical" | "at_risk" | "watch" | "on_track"; days: number; text: string;
}
export interface LeadHealth { level: HealthLevel; reasons: HealthReason[] }
export type LevelCounts = Record<HealthLevel, number>;
export interface HealthItem {
  company: string; owner: string | null; region: string | null; country: string | null;
  stage_no: number | null; stage_name: string | null; potential_cr: number | null;
  next_action: string | null; next_action_date: string | null; target_close_date: string | null;
  health: LeadHealth;
}
export interface HealthSplit { key: string | number | null; label: string | null; leads: number; counts: LevelCounts }
export interface HealthSummary {
  levels: HealthLevel[];
  thresholds: {
    stage_days: [number, number, number]; contact_days: [number, number, number];
    next_action_due_soon: number; next_action_overdue: [number, number];
    target_due_soon: number; target_past: [number, number];
  };
  counts: LevelCounts; open: number;
  lists: Record<"critical" | "at_risk" | "watch", {
    items: HealthItem[]; total: number; potential_cr: number | null; potential_count: number;
  }>;
  by_stage: HealthSplit[]; by_owner: HealthSplit[]; by_region: HealthSplit[];
  stage_age: { key: string | null; leads: number }[];
  target_timeline: { year: number; month: number; leads: number; potential_cr: number | null;
                     potential_count: number; when: "past" | "current" | "future" }[];
  no_target: number;
  gaps: { no_owner: number; no_activity: number; no_next_action: number; no_target: number;
          no_potential: number; working: number };
}

/**
 * The traffic light. One meaning per colour on this page: red is the same red
 * as an overdue next action, amber the same as a lead gone quiet — they are
 * the clocks that set it. Green here means "on pace"; the only other green on
 * the page is Won, which is the same idea (good) and never sits in the same
 * chart, because a closed lead has no health.
 *
 * Grey has two shades because "parked on purpose" and "we cannot tell" are
 * different messages: the first is a decision, the second is a gap in the sheet.
 */
// `ink` is the figure printed ON the swatch: white only where it reads.
export const HEALTH: Record<HealthLevel, { label: string; swatch: string; ink: string; text: string; chip: string }> = {
  critical: { label: "Act now",        swatch: KPI.danger.color,     ink: "#ffffff", text: "text-red-600",
              chip: "bg-red-50 text-red-700 border-red-100" },
  at_risk:  { label: "At risk",        swatch: KPI.warning.color,    ink: "#ffffff", text: "text-amber-600",
              chip: "bg-amber-50 text-amber-700 border-amber-100" },
  watch:    { label: "Watch",          swatch: KPI.caution.color,    ink: "#1f2937", text: "text-yellow-700",
              chip: "bg-yellow-50 text-yellow-800 border-yellow-200" },
  on_track: { label: "On track",       swatch: KPI.conversion.color, ink: "#ffffff", text: "text-green-700",
              chip: "bg-green-50 text-green-700 border-green-100" },
  parked:   { label: "On hold",        swatch: FUNNEL_MISSED,        ink: "#1f2937", text: "text-gray-600",
              chip: "bg-gray-100 text-gray-600 border-gray-200" },
  unknown:  { label: "Can't tell yet", swatch: NEUTRAL_BAR,          ink: "#1f2937", text: "text-gray-500",
              chip: "bg-white text-gray-500 border-gray-300 border-dashed" },
};
export const HEALTH_ORDER: HealthLevel[] = ["critical", "at_risk", "watch", "on_track", "parked", "unknown"];

export function HealthPill({ level, className = "" }: { level: HealthLevel; className?: string }) {
  const h = HEALTH[level];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${h.chip} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: h.swatch }} />
      {h.label}
    </span>
  );
}

/** One stacked bar of open leads by level — the shape every health split uses. */
export function HealthBar({ counts, total, height = "h-3.5" }: { counts: LevelCounts; total: number; height?: string }) {
  if (!total) return <span className={`block ${height} rounded-md bg-gray-50`} />;
  return (
    <span className={`flex ${height} rounded-md overflow-hidden bg-gray-50`}>
      {HEALTH_ORDER.map((lv) => counts[lv] ? (
        <span key={lv} title={`${HEALTH[lv].label}: ${counts[lv]}`}
          style={{ width: `${(counts[lv] / total) * 100}%`, background: HEALTH[lv].swatch }} />
      ) : null)}
    </span>
  );
}

export interface SyncMeta { registered: boolean; last_synced_at: string | null; last_sync_status: string | null }
export interface Summary {
  as_of: string; stale_days: number;
  kpis: {
    leads: number; open: number; active: number; on_hold: number; won: number; lost: number;
    no_status: number; pipeline: Pot; won_potential: Pot; stale: number; overdue_actions: number;
    past_target: number;
  };
  funnel: FunnelRow[];
  no_stage_open: number;
  by_region: Group[]; by_owner: Group[]; by_customer_type: Group[]; by_source: Group[];
  attention: {
    overdue_actions: AttentionItem[]; stale: AttentionItem[]; past_target: AttentionItem[];
    longest_in_stage: AttentionItem[];
  };
  lost_reasons: { key: string | null; leads: number }[];
  data_quality: {
    leads: number; open: number; closed: number; lost: number;
    missing_owner: number; missing_stage: number;
    missing_target_close: number; missing_last_contact: number; missing_potential: number;
    missing_region: number; missing_lost_reason: number;
  };
  tracking_since: string | null;
  region_labels: Record<string, string>;
  health: HealthSummary;
  recent: {
    days: number; from: string;
    movement: ActivityResponse["movement"]; touches: number; companies: number;
    feed: FeedItem[]; feed_total: number;
  };
  sync: SyncMeta;
}

export interface RecentActivity {
  date: string; activity_type: string | null; by_person: string | null; notes: string | null;
}

// ── Activity tab (/export/activity) ──
export interface FeedItem {
  date: string;
  type: "activity" | "added" | "removed" | "stage" | "status";
  company: string;
  activity_type?: string | null; by_person?: string | null; notes?: string | null; matched?: boolean;
  from_stage?: number | null; to_stage?: number | null;
  from_status?: string | null; to_status?: string | null;
}
export interface CloseItem {
  company: string; status: "Won" | "Lost"; closed_on: string; owner: string | null;
  region: string | null; potential_cr: number | null; lost_reason: string | null; stage_no: number | null;
}
export interface ActivityResponse {
  movement: { added: number; removed: number; advanced: number; went_back: number; staged: number;
              on_hold: number; won: number; lost: number };
  closes: CloseItem[];
  stage_flow: { stage: number; name: string; entered: number; moved_on: number; went_back: number }[];
  activity: {
    touches: number; companies: number; open_leads: number; open_touched: number; unmatched: number;
    by_type: { key: string | null; count: number }[];
    by_person: { key: string | null; count: number }[];
  };
  feed: FeedItem[]; feed_total: number;
  window: { from: string | null; to: string | null };
  lead_filtered: boolean;
  tracking_since: string | null;
  sync: SyncMeta;
}
export interface Lead {
  sheet_row: number; company: string; owner: string | null; customer_type: string | null;
  country: string | null; region: string | null; city: string | null;
  contact_person: string | null; contact_email: string | null; contact_phone: string | null;
  stage_no: number | null; stage_name: string | null;
  status: string | null; target_close_date: string | null; lost_reason: string | null;
  /** Derived, not typed: the day a sync saw it become Won/Lost. Null if it
   *  closed before tracking began. */
  closed_on: string | null;
  potential_cr: number | null; last_contact: string | null;
  next_action: string | null; next_action_date: string | null; source: string | null;
  remarks: string | null;
  is_open: boolean; days_in_stage: number | null; days_in_stage_basis: StageBasis;
  days_since_contact: number | null;
  stale: boolean | null; next_action_overdue: boolean | null; past_target: boolean | null;
  /** Null for a closed lead. */
  health: LeadHealth | null;
  recent_activity: RecentActivity[];
}
export interface FilterOptions {
  owners: string[]; customer_types: string[]; countries: string[]; sources: string[];
  regions: { value: string; label: string }[];
  stages: { value: number; label: string }[];
  statuses: string[];
  health: { value: HealthLevel; label: string }[];
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** ₹ crore as the team enters it. The sheet holds crores to two decimals, so
 *  that is all the precision there is to show. */
export const fmtCr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;

/** "What this total covers" — the caption every potential figure carries. */
export const potCoverage = (p: Pot) =>
  p.leads === 0 ? "no leads" : `${p.potential_count} of ${p.leads} lead${p.leads === 1 ? "" : "s"} estimated`;

export function fmtDay(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Label for a grouping key the team left blank. Always shown, never dropped:
 *  a blank that disappears from a split makes the split look complete. */
export const NOT_SET = "Not set";

export const STATUS_STYLE: Record<string, string> = {
  // Orange is "open pipeline" everywhere on this page, so Active wears it.
  Active: "bg-orange-50 text-brand-orange border-orange-100",
  "On Hold": "bg-gray-100 text-gray-600 border-gray-200",
  Won: "bg-green-50 text-green-700 border-green-100",
  Lost: "bg-gray-50 text-gray-500 border-gray-200 line-through",
};

// ── Filters ───────────────────────────────────────────────────────────────────

export interface Filters {
  owner: string; region: string; country: string; customerType: string;
  stage: string; status: string; health: string; source: string; q: string;
}
export const NO_FILTERS: Filters = {
  owner: "", region: "", country: "", customerType: "", stage: "", status: "", health: "", source: "", q: "",
};

export function filterParams(f: Filters, staleDays: number) {
  const p = new URLSearchParams();
  if (f.owner) p.set("owner", f.owner);
  if (f.region) p.set("region", f.region);
  if (f.country) p.set("country", f.country);
  if (f.customerType) p.set("customer_type", f.customerType);
  if (f.stage) p.set("stage", f.stage);
  if (f.status) p.set("status", f.status);
  if (f.health) p.set("health", f.health);
  if (f.source) p.set("source", f.source);
  if (f.q.trim()) p.set("q", f.q.trim());
  p.set("stale_days", String(staleDays));
  return p;
}

export const hasAnyFilter = (f: Filters) => Object.values(f).some((v) => v.trim() !== "");

/** Words for the active filters, for the "may be excluding everything" line
 *  and the printed header. */
export function describeFilters(f: Filters, opts: FilterOptions | null) {
  const stage = opts?.stages.find((s) => String(s.value) === f.stage)?.label;
  const region = opts?.regions.find((r) => r.value === f.region)?.label ?? f.region;
  return [
    f.owner && f.owner, f.region && region, f.country && f.country,
    f.customerType && f.customerType, stage && `Stage ${stage}`, f.status && f.status,
    f.health && HEALTH[f.health as HealthLevel]?.label, f.source && f.source,
    f.q.trim() && `"${f.q.trim()}"`,
  ].filter(Boolean) as string[];
}

const inputClass =
  "h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all";

/**
 * The Export filter bar. Order is the app-wide one: period, person, geography,
 * then type, then search.
 *
 * `period` is passed only by the Activity tab. Pipeline and Leads are the list
 * as it stands today — the sheet is overwritten as leads move, so a period
 * control there would only filter by some date column and imply a history
 * those views do not have.
 *
 * Nine filters is past the point where a bar stays scannable, so the three
 * used least — Country (Market covers most questions), Customer type and
 * Source — sit in the "More filters" popover, whose button says how many of
 * them are on. Health is in the bar: it is the one management reaches for.
 */
export function ExportFilterBar({
  filters, setFilters, options, loading, syncing, onRefresh, onSync, sync, period,
}: {
  filters: Filters; setFilters: (f: Filters) => void; options: FilterOptions | null;
  loading: boolean; syncing: boolean; onRefresh: () => void; onSync: () => void;
  sync: SyncMeta | null; period?: React.ReactNode;
}) {
  // The search box is typed into; the filter it feeds is debounced so each
  // keystroke is not a request.
  const [q, setQ] = useState(filters.q);
  useEffect(() => { setQ(filters.q); }, [filters.q]);
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => setFilters({ ...filters, q }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const set = (k: keyof Filters) => (v: string) => setFilters({ ...filters, [k]: v });

  return (
    <FilterBar>
      {period}
      <Select value={filters.owner} onChange={set("owner")}
        options={filterOpts(options?.owners, "salesperson")}
        placeholder={FILTER_LABELS.salesperson.placeholder} />
      <Select value={filters.region} onChange={set("region")}
        options={[{ value: "", label: FILTER_LABELS.region.all }, ...(options?.regions ?? [])]}
        placeholder={FILTER_LABELS.region.placeholder} />
      <Select value={filters.stage} onChange={set("stage")}
        options={[{ value: "", label: FILTER_LABELS.stage.all },
                  ...(options?.stages ?? []).map((s) => ({ value: String(s.value), label: s.label }))]}
        placeholder={FILTER_LABELS.stage.placeholder} />
      <Select value={filters.status} onChange={set("status")}
        options={toOpts(options?.statuses, FILTER_LABELS.status.all)}
        placeholder={FILTER_LABELS.status.placeholder} />
      <Select value={filters.health} onChange={set("health")}
        options={[{ value: "", label: FILTER_LABELS.health.all }, ...(options?.health ?? [])]}
        placeholder={FILTER_LABELS.health.placeholder} />
      <FilterOverflow active={[filters.country, filters.customerType, filters.source].filter(Boolean).length}>
        <Select value={filters.country} onChange={set("country")} className="w-full"
          options={filterOpts(options?.countries, "country")}
          placeholder={FILTER_LABELS.country.placeholder} />
        <Select value={filters.customerType} onChange={set("customerType")} className="w-full"
          options={filterOpts(options?.customer_types, "customerType")}
          placeholder={FILTER_LABELS.customerType.placeholder} />
        <Select value={filters.source} onChange={set("source")} className="w-full"
          options={filterOpts(options?.sources, "source")}
          placeholder={FILTER_LABELS.source.placeholder} />
      </FilterOverflow>
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, contact…"
          className={`${inputClass} pl-8 w-44`} />
      </div>
      <ClearFilters show={hasAnyFilter(filters)} onClear={() => setFilters(NO_FILTERS)} />
      <FilterSpinner show={loading} />
      <FilterActions>
        {sync?.last_synced_at && (
          <span className="text-[10px] text-gray-500 hidden xl:block" title="Most recent sheet sync">
            Data as of {formatDate(sync.last_synced_at)}
          </span>
        )}
        <RefreshButton onClick={onRefresh} disabled={loading} />
        <SyncButton onClick={onSync} syncing={syncing}
          title="Pull the latest rows from the export team's Leads sheet" />
        <PdfButton />
      </FilterActions>
    </FilterBar>
  );
}

/** A panel's frame — `p-5`, the panel tier. */
export function Panel({ title, sub, right, children, className = "" }: {
  title: string; sub?: React.ReactNode; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">{title}</h3>
          {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {children}
    </div>
  );
}
