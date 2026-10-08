// Export — the UK / EU / AU lead pipeline, read from the export team's
// `Leads` sheet (see backend/routers/export.py).
//
// Filters live here, above the tabs, and every tab is fed from the same filter
// state: /summary, /leads and /activity take identical lead filters, so the
// count on the Pipeline tab is always the number of rows on the Leads tab.
// Only the Activity tab adds a period — see ExportFilterBar.
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import {
  API_URL, ExportFilterBar, NO_FILTERS, filterParams, hasAnyFilter, describeFilters,
  PeriodControls, usePeriod, periodParams, fmtDay,
  type Filters, type FilterOptions, type Summary, type Lead, type SyncMeta, type ActivityResponse,
} from "./shared";
import ActivityTab from "./ActivityTab";
import PipelineTab from "./PipelineTab";
import LeadsTab from "./LeadsTab";
import SheetTab from "./SheetTab";

type TabId = "pipeline" | "leads" | "activity" | "sheet";

const TABS: { id: TabId; label: string }[] = [
  { id: "pipeline", label: "Pipeline" },
  { id: "leads", label: "Leads" },
  { id: "activity", label: "Activity" },
  { id: "sheet", label: "Data Source Sheet" },
];

const TAB_SUBTITLES: Record<TabId, string> = {
  pipeline: "UK, Europe and Australia leads — where each one stands today",
  leads: "Every lead in the selection, with its contacts, dates and next action",
  activity: "What happened in a period — contacts logged, stage moves, wins and losses",
  sheet: "Connect and sync the export team's Leads sheet",
};

// Register and remove are refused by the API for anyone else; hiding the tab
// is a convenience, not the control.
const MANAGERS = new Set(["superadmin", "management"]);

export default function ExportPage() {
  const { token, user } = useAuth();
  const toast = useToast();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const canManage = MANAGERS.has(user?.role ?? "");
  const tabs = useMemo(() => TABS.filter((t) => t.id !== "sheet" || canManage), [canManage]);

  const [activeTab, setActiveTab] = useState<TabId>("pipeline");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [staleDays, setStaleDays] = useState(30);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [activityData, setActivityData] = useState<ActivityResponse | null>(null);
  const period = usePeriod("monthly");
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [sync, setSync] = useState<SyncMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

  // Options come from their own endpoint and are never cut by the current
  // filter — a dropdown that shrinks to the active selection traps the user.
  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/export/filter-options`, { headers });
      if (res.ok) setOptions(await res.json());
    })();
  }, [headers, refreshKey]);

  // The Activity tab's months come from their own endpoint, BEFORE its first
  // data request: deriving them from the response would deadlock (no month
  // chosen, no request; no request, no months).
  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/export/periods`, { headers });
      if (!res.ok) return;
      const body: { months: { year: number; month: number }[] } = await res.json();
      period.setMonths(body.months);
      setPeriodsLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, refreshKey]);

  // Land on the newest month that has anything in it, not the calendar month.
  // With nothing recorded at all there is no month to land on, so the tab
  // opens on all time and says so, rather than on an empty picker.
  useEffect(() => {
    if (!periodsLoaded || period.token || period.mode === "custom" || period.mode === "all") return;
    if (period.options.length) period.setToken(period.options[0].value);
    else period.switchMode("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodsLoaded, period.options]);

  const pp = periodParams(period.mode, period.token, period.range);
  const ppKey = JSON.stringify(pp);

  useEffect(() => {
    if (activeTab === "sheet") return;
    const params = filterParams(filters, staleDays);
    if (activeTab === "activity") {
      // Half a custom range, or months still loading: nothing to ask yet.
      // Clear rather than leave the previous window's numbers under a period
      // they do not belong to.
      if (!pp) { setActivityData(null); setLoading(false); return; }
      Object.entries(pp).forEach(([k, v]) => params.set(k, v));
    }
    // Abort on supersede: a slow earlier response must not land after a newer
    // one and show the wrong filter's leads.
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const path = { pipeline: "summary", leads: "leads", activity: "activity" }[activeTab];
        const res = await fetch(`${API_URL}/export/${path}?${params}`, { headers, signal: ctrl.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? `Request failed (${res.status})`);
        setError(null);
        if (activeTab === "pipeline") setSummary(body);
        else if (activeTab === "leads") setLeads(body.leads);
        else setActivityData(body);
        setSync(body.sync);
        setLoading(false);
      } catch (e) {
        if (ctrl.signal.aborted) return;   // the newer request owns the loading flag
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, filters, staleDays, headers, refreshKey, ppKey]);

  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab("pipeline");
  }, [tabs, activeTab]);

  const runSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch(`${API_URL}/export/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Sync failed");
      const n: number = data.warnings?.length ?? 0;
      // Say what the history recorded: "3 changes" is the answer to "did my
      // update land", and a first sync must not look like one that saw nothing.
      const recorded = data.baseline
        ? "starting point for stage history recorded"
        : `${data.changes} change${data.changes === 1 ? "" : "s"} recorded`;
      const loaded = `${data.rows_inserted} leads, ${data.activities} contacts · ${recorded}`;
      if (n) {
        toast.warning(`Synced — ${loaded}`,
          `${n} problem${n === 1 ? "" : "s"} in the sheet${canManage ? " — listed on the Data Source Sheet tab" : ""}`);
      } else {
        toast.success("Sync complete", loaded);
      }
    } catch (e) {
      toast.error("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
      refresh();
    }
  }, [syncing, headers, toast, canManage, refresh]);

  const regionLabel = useCallback((r: string | null) => {
    if (r == null) return "Not set";
    return options?.regions.find((o) => o.value === r)?.label ?? summary?.region_labels[r] ?? r;
  }, [options, summary]);

  const pickStage = (stage: number) => {
    setFilters({ ...filters, stage: String(stage) });
    setActiveTab("leads");
  };

  const windowLabel = period.mode === "all" ? "all time"
    : period.mode === "custom"
      ? (period.range.from && period.range.to ? `${fmtDay(period.range.from)} – ${fmtDay(period.range.to)}` : "the chosen dates")
      : period.options.find((o) => o.value === period.token)?.label ?? "this period";

  const active = describeFilters(filters, options);
  const filtered = hasAnyFilter(filters);
  const registered = sync?.registered ?? true;
  const nothingSynced = registered && !filtered
    && ((activeTab === "pipeline" && summary?.kpis.leads === 0) || (activeTab === "leads" && leads?.length === 0));
  const emptySelection = filtered
    && ((activeTab === "pipeline" && summary?.kpis.leads === 0) || (activeTab === "leads" && leads?.length === 0));

  return (
    <div className="p-6 flex flex-col gap-5">
      <div className="print-only mb-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-500">Amato · Export</div>
        <div className="text-xl font-bold text-gray-900 mt-0.5">
          {tabs.find((t) => t.id === activeTab)?.label}{active.length ? ` · ${active.join(" · ")}` : ""}
        </div>
      </div>

      {/* Title shrinks, tab strip does not — see CLAUDE.md § Page header. */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        className="no-print flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-0">
            <span className="page-title-dark">EXPORT</span>
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

      {activeTab === "sheet" ? (
        <SheetTab headers={headers} onSync={runSync} syncing={syncing} onChanged={refresh} />
      ) : (
        <>
          <ExportFilterBar filters={filters} setFilters={setFilters} options={options}
            loading={loading} syncing={syncing} onRefresh={refresh} onSync={runSync} sync={sync}
            period={activeTab === "activity" ? (
              <PeriodControls
                mode={period.mode} onMode={period.switchMode}
                token={period.token} onToken={period.setToken} options={period.options}
                range={period.range} onRange={period.setRange} />
            ) : undefined} />

          {error ? (
            <Notice>
              <p className="font-semibold text-gray-600 mb-1">Could not load the export pipeline</p>
              <p>{error}</p>
            </Notice>
          ) : !registered ? (
            <Notice>
              No export sheet is connected yet.{" "}
              {canManage
                ? <>Register the export team&rsquo;s workbook on the{" "}
                    <button onClick={() => setActiveTab("sheet")}
                      className="font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                      Data Source Sheet
                    </button> tab.</>
                : "Ask a management user to connect it."}
            </Notice>
          ) : nothingSynced ? (
            <Notice>
              The sheet is connected but no leads have been loaded — press <b className="text-gray-600">Sync</b> to
              pull them{canManage ? ", and check the Data Source Sheet tab if it reports a problem" : ""}.
            </Notice>
          ) : emptySelection ? (
            <Notice>
              <p className="font-semibold text-gray-600 mb-1.5">No leads match this selection</p>
              <p>
                The <b className="text-gray-600">{active.join(" + ")}</b> filter
                {active.length > 1 ? "s exclude" : " excludes"} every lead —{" "}
                <button onClick={() => setFilters(NO_FILTERS)}
                  className="font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                  clear {active.length > 1 ? "them" : "it"}
                </button>.
              </p>
            </Notice>
          ) : activeTab === "pipeline" ? (
            summary && <PipelineTab data={summary} staleDays={staleDays} setStaleDays={setStaleDays}
              regionLabel={regionLabel} onPickStage={pickStage} />
          ) : activeTab === "leads" ? (
            leads && <LeadsTab leads={leads} staleDays={staleDays} regionLabel={regionLabel} />
          ) : period.mode === "custom" && !pp ? (
            <Notice>Pick a start and an end date to see what happened across a custom period.</Notice>
          ) : (
            activityData && <ActivityTab data={activityData} windowLabel={windowLabel}
              isAllTime={period.mode === "all"} onAllTime={() => period.switchMode("all")} />
          )}
        </>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
      {children}
    </div>
  );
}
