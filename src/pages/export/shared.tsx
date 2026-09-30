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
  FILTER_LABELS, filterOpts, toOpts,
} from "@/components/ui/FilterBar";
import { formatDate } from "@/lib/format";

export { API_URL, StatCard, KPI, VISIT_COLOR, NEUTRAL_BAR, TGT_TRACK } from "../oe-network/shared";

// ── API shapes ────────────────────────────────────────────────────────────────

/** A potential total and how many leads it covers — they always travel
 *  together, because most leads carry no estimate. */
export interface Pot { potential_cr: number | null; potential_count: number; leads: number }
export interface Group { key: string | null; leads: number; open: number; won: number; lost: number; pipeline: Pot }
export interface FunnelRow {
  stage: number; name: string; open_here: number; reached: number; pipeline: Pot;
  median_days_in_stage: number | null; days_known: number;
}
export interface AttentionItem {
  company: string; owner: string | null; region: string | null;
  stage_no: number | null; stage_name: string | null;
  days_in_stage: number | null; days_since_contact: number | null;
  next_action: string | null; next_action_date: string | null;
}
export interface SyncMeta { registered: boolean; last_synced_at: string | null; last_sync_status: string | null }
export interface Summary {
  as_of: string; stale_days: number;
  kpis: {
    leads: number; open: number; active: number; on_hold: number; won: number; lost: number;
    no_status: number; pipeline: Pot; won_potential: Pot; stale: number; overdue_actions: number;
  };
  funnel: FunnelRow[];
  no_stage_open: number;
  by_region: Group[]; by_owner: Group[]; by_customer_type: Group[]; by_source: Group[];
  attention: { overdue_actions: AttentionItem[]; stale: AttentionItem[]; longest_in_stage: AttentionItem[] };
  data_quality: {
    leads: number; open: number; missing_owner: number; missing_stage: number;
    missing_stage_since: number; missing_last_contact: number; missing_potential: number;
    missing_region: number;
  };
  region_labels: Record<string, string>;
  sync: SyncMeta;
}
export interface Lead {
  sheet_row: number; company: string; owner: string | null; customer_type: string | null;
  country: string | null; region: string | null; city: string | null;
  contact_person: string | null; contact_email: string | null; contact_phone: string | null;
  stage_no: number | null; stage_name: string | null; stage_since: string | null;
  status: string | null; potential_cr: number | null; last_contact: string | null;
  next_action: string | null; next_action_date: string | null; source: string | null;
  remarks: string | null;
  is_open: boolean; days_in_stage: number | null; days_since_contact: number | null;
  stale: boolean | null; next_action_overdue: boolean | null;
}
export interface FilterOptions {
  owners: string[]; customer_types: string[]; countries: string[]; sources: string[];
  regions: { value: string; label: string }[];
  stages: { value: number; label: string }[];
  statuses: string[];
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
  stage: string; status: string; q: string;
}
export const NO_FILTERS: Filters = {
  owner: "", region: "", country: "", customerType: "", stage: "", status: "", q: "",
};

export function filterParams(f: Filters, staleDays: number) {
  const p = new URLSearchParams();
  if (f.owner) p.set("owner", f.owner);
  if (f.region) p.set("region", f.region);
  if (f.country) p.set("country", f.country);
  if (f.customerType) p.set("customer_type", f.customerType);
  if (f.stage) p.set("stage", f.stage);
  if (f.status) p.set("status", f.status);
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
    f.q.trim() && `"${f.q.trim()}"`,
  ].filter(Boolean) as string[];
}

const inputClass =
  "h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all";

/**
 * The Export filter bar. Order is the app-wide one: person, geography, then
 * type, then search. No PeriodControls — the pipeline is a snapshot of today,
 * see the page header note.
 *
 * Source is deliberately not a filter: it would be the eighth, past the point
 * where a bar stops being scannable, and the pipeline tab already splits by it.
 */
export function ExportFilterBar({
  filters, setFilters, options, loading, syncing, onRefresh, onSync, sync,
}: {
  filters: Filters; setFilters: (f: Filters) => void; options: FilterOptions | null;
  loading: boolean; syncing: boolean; onRefresh: () => void; onSync: () => void;
  sync: SyncMeta | null;
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
      <Select value={filters.owner} onChange={set("owner")}
        options={filterOpts(options?.owners, "salesperson")}
        placeholder={FILTER_LABELS.salesperson.placeholder} />
      <Select value={filters.region} onChange={set("region")}
        options={[{ value: "", label: FILTER_LABELS.region.all }, ...(options?.regions ?? [])]}
        placeholder={FILTER_LABELS.region.placeholder} />
      <Select value={filters.country} onChange={set("country")}
        options={filterOpts(options?.countries, "country")}
        placeholder={FILTER_LABELS.country.placeholder} />
      <Select value={filters.customerType} onChange={set("customerType")}
        options={filterOpts(options?.customer_types, "customerType")}
        placeholder={FILTER_LABELS.customerType.placeholder} />
      <Select value={filters.stage} onChange={set("stage")}
        options={[{ value: "", label: FILTER_LABELS.stage.all },
                  ...(options?.stages ?? []).map((s) => ({ value: String(s.value), label: s.label }))]}
        placeholder={FILTER_LABELS.stage.placeholder} />
      <Select value={filters.status} onChange={set("status")}
        options={toOpts(options?.statuses, FILTER_LABELS.status.all)}
        placeholder={FILTER_LABELS.status.placeholder} />
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
