import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw, Plus, ChevronDown, ChevronUp, CheckCircle2, XCircle, Clock, History, Trash2, Pencil, Printer, Database,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import BalanceSheetView from "@/pages/finance/BalanceSheetView";
import ProfitLossView from "@/pages/finance/ProfitLossView";
import PlantOpsView from "@/pages/finance/PlantOpsView";
import CashFlowView from "@/pages/finance/CashFlowView";
import ConsolidatedView from "@/pages/finance/ConsolidatedView";
import { StickyLeadingContext } from "@/pages/finance/dashboardKit";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// A synthetic entry in the company dropdown rather than a real sheet_source —
// it selects "every company at once" instead of one company, so it deliberately
// cannot collide with a real UUID.
const CONSOLIDATED_ID = "__consolidated__";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface SheetSourceItem { id: string; sheet_id: string; label: string; created_at: string; }
interface MasterItem { id: string; sheet_id: string; label: string; last_synced_at: string | null; last_sync_status: string | null; }
interface SyncResult {
  sync_id: string; companies?: number; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; errors: string[]; status: string;
}
interface SyncHistoryItem {
  id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; status: string; synced_at: string;
}
type Statement = "balance_sheet" | "profit_loss" | "plant_ops" | "cash_flow";
type Tab = Statement | "sheets";

export default function FinancePage() {
  const { token, user } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === "superadmin" || user?.role === "management";
  const toast = useToast();

  const [sources, setSources] = useState<SheetSourceItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<Tab>("balance_sheet");
  const [refreshNonce, setRefreshNonce] = useState(0); // bumped after a sync to refetch the active view

  // Once the page's own company selector scrolls out of view, a compact copy of
  // it takes over the sticky controls bar so switching company never needs a
  // scroll back to the top.
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const [selectorVisible, setSelectorVisible] = useState(true);

  // The sticky header wraps at narrow widths, so its height is measured rather
  // than hardcoded — the controls bar sticks directly beneath whatever it is.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerH, setHeaderH] = useState(76);

  // Master data files (admin only)
  const [masters, setMasters] = useState<MasterItem[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLink, setNewLink] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string>("");

  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showSyncErrors, setShowSyncErrors] = useState(false);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources`, { headers });
      if (!res.ok) return;
      const data: SheetSourceItem[] = await res.json();
      setSources(data);
      // Consolidated is synthetic, so it isn't in `data` — keep it selected
      // explicitly, or a Refresh/sync would silently bounce back to company #1.
      setSelectedId((cur) =>
        cur && (cur === CONSOLIDATED_ID || data.some((s) => s.id === cur)) ? cur : (data[0]?.id ?? "")
      );
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadMasters = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_URL}/finance/masters`, { headers });
      if (res.ok) setMasters(await res.json());
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin]);

  const loadHistory = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_URL}/finance/sync-history`, { headers });
      if (res.ok) { setHistory(await res.json()); setHistoryLoaded(true); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin]);

  useEffect(() => { loadSources(); loadMasters(); loadHistory(); }, [loadSources, loadMasters, loadHistory]);

  // The browser stamps its own header/footer (page title "AMATO AUTOMOTIVE MIS",
  // URL) into the page margin; a zero @page margin leaves it no room, so the
  // board pack carries only our own header. Mounted with this page so other
  // modules' PDFs keep the default; .finance-print restores the whitespace on
  // every page via box-decoration-break.
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "@media print { @page { margin: 0; } }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // Track the sticky header's height so the controls bar can sit flush under it
  // instead of overlapping when the header wraps to two rows.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight));
    ro.observe(el);
    setHeaderH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // Watch the real selector; the sticky stand-in appears only once it's gone.
  // rootMargin's top offset matches the sticky bar so the swap happens exactly
  // as the selector slides under it, not before.
  useEffect(() => {
    const el = selectorRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setSelectorVisible(entry.isIntersecting),
      { rootMargin: `-${headerH + 48}px 0px 0px 0px`, threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [activeTab, headerH]);

  const handleAddMaster = async () => {
    if (!newLink.trim() || !newLabel.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`${API_URL}/finance/masters`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: newLink.trim(), label: newLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add master file");
      setNewLink(""); setNewLabel(""); setShowAddForm(false);
      await loadMasters();
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleSyncMaster = async (id: string) => {
    if (syncingId) return;
    setSyncingId(id);
    setSyncResult(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000); // 3 min safety cap
    try {
      const res = await fetch(`${API_URL}/finance/masters/${id}/sync`, { method: "POST", headers, signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      setRefreshNonce((n) => n + 1);
      loadSources(); loadMasters(); loadHistory();
    } catch (err: any) {
      const msg = err?.name === "AbortError" ? "Sync timed out — the backend may still be finishing; refresh in a moment." : err.message;
      setSyncResult({ sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0, errors: [msg], status: "Error" });
    } finally {
      clearTimeout(timer);
      setSyncingId("");
    }
  };

  const handleDeleteMaster = async (id: string, label: string) => {
    if (!window.confirm(`Remove the "${label}" master file registration?\n\nCompany data stays until the next sync; you can re-register it anytime.`)) return;
    try {
      const res = await fetch(`${API_URL}/finance/masters/${id}`, { method: "DELETE", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      await loadMasters();
      toast.success("Master file removed", `"${label}" is no longer registered.`);
    } catch (e) {
      toast.error("Couldn't remove master file", e instanceof Error ? e.message : "Please try again.");
    }
  };

  const handleRenameCompany = async () => {
    const source = sources.find((s) => s.id === selectedId);
    if (!source) return;
    const label = window.prompt(`Display name for "${source.label}".\n\nOnly the name shown in the app changes — keep the tab name in the master sheets as it is.`, source.label)?.trim();
    if (!label || label === source.label) return;
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources/${source.id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      await loadSources();
      toast.success("Company renamed", `"${source.label}" is now "${label}".`);
    } catch (e) {
      toast.error("Couldn't rename company", e instanceof Error ? e.message : "Please try again.");
    }
  };

  const handleDeleteCompany = async () => {
    if (!selectedId) return;
    const source = sources.find((s) => s.id === selectedId);
    if (!source) return;
    if (!window.confirm(`Delete company "${source.label}"?\n\nThis removes all its finance data. It will reappear on the next master sync if its tab still exists.`)) return;
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources/${selectedId}`, { method: "DELETE", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      setSelectedId("");
      await loadSources();
      toast.success("Company deleted", `"${source.label}" and its finance data were removed.`);
    } catch (e) {
      toast.error("Couldn't delete company", e instanceof Error ? e.message : "Please try again.");
    }
  };

  const isConsolidated = selectedId === CONSOLIDATED_ID;
  const companyLabel = isConsolidated ? "ALL COMPANIES" : (sources.find((s) => s.id === selectedId)?.label ?? "");
  const statementLabel = isConsolidated
    ? "P&L & Balance Sheet"
    : activeTab === "balance_sheet" ? "Balance Sheet" : activeTab === "profit_loss" ? "Profit & Loss" : activeTab === "cash_flow" ? "Cash Flow" : "Plant Operations";
  const onSheetsTab = activeTab === "sheets";

  // Pinned above the individual companies — it reads as the overview you drill
  // down FROM, and stays put as companies are added. Deliberately NOT called
  // "consolidated": that term means summed with inter-company eliminations,
  // whereas this view shows each company as reported and adds nothing.
  const companyOptions = [
    ...(sources.length > 0 ? [{ value: CONSOLIDATED_ID, label: "ALL COMPANIES" }] : []),
    ...sources.map((s) => ({ value: s.id, label: s.label })),
  ];

  // Fed to the views' sticky controls bar via context. null keeps the plain
  // "View" label, so nothing changes until the real selector scrolls away.
  const stickyCompanySelector = selectorVisible ? null : (
    <Select
      value={selectedId}
      onChange={setSelectedId}
      placeholder="Select a company…"
      options={companyOptions}
      className="min-w-[150px]"
    />
  );

  // The four statement tabs are per-company, so they don't apply to the
  // consolidated view — which shows P&L and Balance Sheet together on one page.
  // Sheets stays reachable either way, being config rather than a company view.
  const TABS: [Tab, string][] = [
    ...(isConsolidated ? [] : ([
      ["balance_sheet", "Balance Sheet"],
      ["profit_loss", "P&L"],
      ["cash_flow", "Cash Flow"],
      ["plant_ops", "Plant Ops"],
    ] as [Tab, string][])),
    // Key stays "sheets"; the label reads "Data Sources" so the tab matches the
    // heading inside it and doesn't surface the Google-Sheets plumbing.
    ...(isAdmin ? [["sheets", "Data Sources"] as [Tab, string]] : []),
  ];

  return (
    <div className="finance-print p-6 flex flex-col gap-6">
      {/* Print-only board-pack header */}
      <div className="print-only mb-2">
        <div className="text-xl font-bold text-gray-900">{companyLabel} — {statementLabel}</div>
        <div className="text-[11px] text-gray-500">Generated {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</div>
      </div>

      {/* Header — title and the tab switcher share one row so they line up, and the
          whole row is sticky so the tabs stay reachable while scrolling (a nested tab
          bar can only stick within its own row, so the header itself is the sticky
          element). The per-view VIEW controls sticky-stack just beneath it. */}
      <motion.div ref={headerRef} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        className="no-print sticky top-0 z-30 -mx-6 px-6 py-3 bg-white/95 backdrop-blur flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-3"><span className="page-title-dark">Financial Review</span></h1>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-0.5 bg-gray-800 rounded" />
            <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
              {isConsolidated
                ? "Profit & Loss and Balance Sheet, every company side by side"
                : "Balance Sheet · Profit & Loss · Cash Flow · Plant Operations, per company"}
            </p>
          </div>
        </div>
        {TABS.length > 0 && (
          <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
            {TABS.map(([key, label]) => (
              <button key={key} onClick={() => setActiveTab(key)}
                className={`text-xs font-bold px-4 py-2 rounded-lg transition-all ${activeTab === key ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </motion.div>

      {/* Company selector (view) — hidden on the Sheets tab, which is config, not a company view */}
      {!onSheetsTab && (
        <div ref={selectorRef} className="no-print flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Select
              value={selectedId}
              onChange={setSelectedId}
              placeholder="Select a company…"
              options={companyOptions}
              className="min-w-[180px]"
            />
            {isAdmin && selectedId && !isConsolidated && (
              <button onClick={handleRenameCompany} title="Rename company"
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800 px-2 py-2 rounded-xl border border-gray-200 hover:border-gray-300 transition-all">
                <Pencil size={13} />
              </button>
            )}
            {isAdmin && selectedId && !isConsolidated && (
              <button onClick={handleDeleteCompany}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-red-500 px-2 py-2 rounded-xl border border-gray-200 hover:border-red-200 transition-all">
                <Trash2 size={13} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setRefreshNonce((n) => n + 1); loadSources(); }}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all"
              title="Re-fetch the latest finance data from the server">
              <RefreshCw size={13} /> Refresh
            </button>
            {selectedId && (
              <button onClick={() => window.print()}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
                <Printer size={13} /> Print / PDF
              </button>
            )}
          </div>
        </div>
      )}

      {/* Data Sources — Sheets tab (admin only) */}
      {isAdmin && onSheetsTab && (
        <div className="no-print bg-white border border-[#EAE3D6] rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Database size={15} className="text-gray-500" /> Data Sources — master files</h2>
            <button onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
              <Plus size={13} /> Add master file
            </button>
          </div>

          {masters.length === 0 ? (
            <p className="text-[13px] text-gray-500">No master files yet. Register the <b>Monthly</b> and <b>Yearly</b> master spreadsheets — each holds every company as a tab. Syncing ingests all companies.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {masters.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 border border-gray-100 rounded-xl px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-gray-800 truncate">{m.label}</div>
                    <div className="text-[11px] text-gray-500 truncate">
                      {m.last_synced_at ? `Last synced ${formatDate(m.last_synced_at)} · ${m.last_sync_status}` : "Never synced"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => handleSyncMaster(m.id)} disabled={!!syncingId}
                      className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 disabled:cursor-not-allowed shadow-md shadow-orange-100 transition-all">
                      {syncingId === m.id ? (<><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>) : (<><RefreshCw size={12} /> Sync</>)}
                    </button>
                    <button onClick={() => handleDeleteMaster(m.id, m.label)} disabled={!!syncingId}
                      className="text-gray-500 hover:text-red-500 px-1.5 py-1.5 rounded-lg border border-gray-200 hover:border-red-200 transition-all disabled:opacity-50">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <AnimatePresence>
            {showAddForm && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="bg-[#FAF7F1] border border-gray-100 rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap gap-3 items-end">
                    <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Master sheet link or ID</label>
                      <input value={newLink} onChange={(e) => setNewLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <div className="flex flex-col gap-1 min-w-[160px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Label</label>
                      <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Monthly master"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <button onClick={handleAddMaster} disabled={adding}
                      className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                      {adding ? "Adding…" : "Add"}
                    </button>
                    <button onClick={() => setShowAddForm(false)} className="h-10 px-3 text-xs font-medium text-gray-500 hover:text-gray-600">Cancel</button>
                  </div>
                  {addError && <p className="text-xs text-red-600">{addError}</p>}
                  <p className="text-[11px] text-gray-500">
                    Share the sheet (Viewer is enough) with the service account before syncing. One tab per company; the same tab name links a company across the monthly and yearly files. After syncing, grant each user access to their companies from the Users page.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {onSheetsTab && syncResult && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`no-print rounded-2xl border p-5 ${syncResult.rows_failed === 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-start gap-4">
              {syncResult.rows_failed === 0 ? <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0 mt-0.5" /> : <XCircle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />}
              <div className="flex-1">
                <p className="font-semibold text-gray-800">Sync {syncResult.status === "Error" ? "failed" : "complete"}{syncResult.companies != null ? ` · ${syncResult.companies} companies` : ""}</p>
                <div className="flex flex-wrap gap-4 mt-2 text-sm">
                  <span className="text-green-700 font-medium">✅ {syncResult.rows_inserted} inserted</span>
                  <span className="text-blue-600 font-medium">🔄 {syncResult.rows_updated} updated</span>
                  {syncResult.rows_deleted > 0 && <span className="text-gray-500 font-medium">🗑 {syncResult.rows_deleted} removed</span>}
                  {syncResult.rows_failed > 0 && <span className="text-red-600 font-medium">❌ {syncResult.rows_failed} failed</span>}
                </div>
                {syncResult.errors.length > 0 && (
                  <div className="mt-3">
                    <button onClick={() => setShowSyncErrors(!showSyncErrors)} className="text-xs text-amber-700 font-medium flex items-center gap-1 hover:underline">
                      {showSyncErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {showSyncErrors ? "Hide" : "Show"} details ({syncResult.errors.length})
                    </button>
                    {showSyncErrors && (
                      <ul className="mt-2 space-y-0.5 text-xs text-amber-800 bg-white/60 rounded-xl p-3">
                        {syncResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!onSheetsTab && !selectedId && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded-2xl p-8 text-center">
          {isAdmin
            ? "No companies yet — register the master files from the Data Sources tab and click Sync to ingest every company tab."
            : "No companies available. Ask an admin to grant you access to a company's finance data."}
        </div>
      )}

      <StickyLeadingContext.Provider value={{ leading: stickyCompanySelector, top: headerH + 8 }}>
        {isConsolidated && !onSheetsTab && <ConsolidatedView refreshNonce={refreshNonce} />}
        {!isConsolidated && selectedId && activeTab === "balance_sheet" && <BalanceSheetView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}
        {!isConsolidated && selectedId && activeTab === "profit_loss" && <ProfitLossView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}
        {!isConsolidated && selectedId && activeTab === "cash_flow" && <CashFlowView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}
        {!isConsolidated && selectedId && activeTab === "plant_ops" && <PlantOpsView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}
      </StickyLeadingContext.Provider>

      {isAdmin && onSheetsTab && (
        <div className="no-print">
          <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2"><History size={16} className="text-gray-500" /> Sync History</h2>
          {!historyLoaded ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-gray-500 bg-gray-50 rounded-2xl p-6 text-center">No syncs yet. Register a master file above and click Sync.</div>
          ) : (
            <div className="bg-white border border-orange-100 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-orange-50 bg-orange-50/40">
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Inserted</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Updated</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Removed</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Failed</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={h.id} className={i % 2 === 0 ? "bg-white" : "bg-orange-50/20"}>
                      <td className="px-4 py-3 text-right text-green-700 font-medium">{h.rows_inserted}</td>
                      <td className="px-4 py-3 text-right text-blue-600 font-medium">{h.rows_updated}</td>
                      <td className="px-4 py-3 text-right text-gray-500 font-medium">{h.rows_deleted}</td>
                      <td className="px-4 py-3 text-right text-red-600 font-medium">{h.rows_failed}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${h.status === "Done" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                          {h.status === "Done" ? <CheckCircle2 size={10} /> : <Clock size={10} />} {h.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(h.synced_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
