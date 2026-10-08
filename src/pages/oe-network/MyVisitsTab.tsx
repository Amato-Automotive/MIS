/**
 * My Visits — a rep's own submissions, in full, exportable.
 *
 * This is what the OTP-only ASM portal (/my-visits) existed to provide, moved
 * inside the MIS now that reps have real accounts: one login, one place to look.
 * Only drawn for a scoped account, because "my" needs a name to mean anything.
 *
 * Unlike the analytics tabs this one is deliberately not a summary — it shows
 * every field the rep actually typed, in the log book's own column order and
 * wording, because the questions it answers are "did my visit get recorded"
 * and "let me send my manager last month's calls".
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Footprints, Phone, Store } from "lucide-react";

import Select from "@/components/ui/Select";
import {
  API_URL, FilterBar, FilterActions, ClearFilters, FilterSpinner, RefreshButton,
  FILTER_LABELS, filterOpts, PeriodControls, usePeriod, periodParams,
  useFilterOptions, shortDate, ModeBadge, StatCard, KPI, useOEScope, ScopeNote,
  SyncButton, useSyncLatest,
} from "./shared";

interface VisitRow {
  visit_date: string | null;
  dealership: string | null; contact_mode: string | null;
  oem: string | null; channel: string | null;
  contact_person: string | null; contact_number: string | null;
  designation: string | null; city: string | null; state: string | null;
  address: string | null;
  car_sales: number | null; seat_cover_sales: number | null; mats_sales: number | null;
  remarks: string | null; remark_product_feedback: string | null;
  remark_replacement: string | null; remark_sales: string | null;
  remark_others: string | null;
  photo_link: string | null; email: string | null;
}

/** Header text and the row cell that answers it, kept as one list so a column
 *  cannot be added to the table without also being given a value — the same
 *  pairing the backend's export keeps for the same reason. */
const COLUMNS: {
  head: string;
  cell: (r: VisitRow) => React.ReactNode;
  align?: "right";
  width?: string;
  clamp?: boolean;
}[] = [
  { head: "Visit Date / Calling Date", cell: (r) => shortDate(r.visit_date) },
  { head: "Dealership Name", cell: (r) => r.dealership || "—", width: "min-w-[160px]" },
  { head: "Visit / Calling", cell: (r) => <ModeBadge mode={r.contact_mode} /> },
  { head: "OEM", cell: (r) => r.oem || "—" },
  { head: "Channel", cell: (r) => r.channel || "—" },
  { head: "Contact Person", cell: (r) => r.contact_person || "—" },
  { head: "Contact No.", cell: (r) => r.contact_number || "—" },
  { head: "Designation", cell: (r) => r.designation || "—" },
  { head: "City", cell: (r) => r.city || "—" },
  { head: "State", cell: (r) => r.state || "—" },
  { head: "Dealership Address", cell: (r) => r.address || "—", width: "max-w-[200px]", clamp: true },
  { head: "Total Car Sales", cell: (r) => r.car_sales ?? "—", align: "right" },
  { head: "Total Seat Covers Sales", cell: (r) => r.seat_cover_sales ?? "—", align: "right" },
  { head: "Mats Sales", cell: (r) => r.mats_sales ?? "—", align: "right" },
  { head: "Remarks", cell: (r) => r.remarks || "—", width: "min-w-[200px]", clamp: true },
  { head: "Product Feedback", cell: (r) => r.remark_product_feedback || "—", width: "min-w-[180px]", clamp: true },
  { head: "Replacement", cell: (r) => r.remark_replacement || "—", width: "min-w-[180px]", clamp: true },
  { head: "Sales", cell: (r) => r.remark_sales || "—", width: "min-w-[180px]", clamp: true },
  { head: "Others", cell: (r) => r.remark_others || "—", width: "min-w-[180px]", clamp: true },
  {
    head: "Photo",
    cell: (r) => (r.photo_link
      ? <a href={r.photo_link} target="_blank" rel="noreferrer"
          className="text-brand-orange underline">View</a>
      : "—"),
  },
  { head: "Email address", cell: (r) => r.email || "—" },
];

const MODE_OPTS = [
  { value: "", label: "Visits + Calls" },
  { value: "Visit", label: "Visits only" },
  { value: "Calling", label: "Calls only" },
];

export default function MyVisitsTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson } = useOEScope();
  const period = usePeriod();
  const options = useFilterOptions<{ oems: string[] }>("logs", headers);

  const [rows, setRows] = useState<VisitRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ visits: 0, calls: 0, dealerships: 0 });
  const [page, setPage] = useState(1);
  const perPage = 30;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [refresh, setRefresh] = useState(0);
  // A rep's usual reason to open this tab is checking the visit they just
  // filed, so the log book is a press away instead of a trip to another tab.
  const { syncing, syncAll } = useSyncLatest(headers, () => setRefresh((x) => x + 1), ["log"]);

  const [oem, setOem] = useState("");
  const [mode, setMode] = useState("");
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const hasFilters = !!(oem || mode || qDeb || period.mode !== "monthly");
  const clearFilters = () => { setOem(""); setMode(""); setQ(""); };

  /** The month list has to exist before the first request, or the period picker
   *  has nothing to land on. Taken from the log months this rep actually has —
   *  /periods is scoped — so a rep never opens on an empty month. */
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_URL}/oe-network/periods`, { headers, signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) period.setMonths(d.log_months ?? []); })
      .catch(() => { /* aborted or offline; the picker stays empty */ });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  useEffect(() => {
    if (!period.token && period.options.length) period.setToken(period.options[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.options]);

  /** Everything the list and the export both filter by. The export reuses it so
   *  the file can never cover a different slice than the table above it. */
  const query = useMemo(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    if (pp === null) return null;         // custom range half-typed
    const p = new URLSearchParams();
    // The endpoint takes days; a month/quarter/year preset arrives as YYYY-MM
    // bounds, so widen them to the first and last day they cover.
    if (pp.from_ym && pp.to_ym) {
      const [ty, tm] = pp.to_ym.split("-").map(Number);
      p.set("from_date", `${pp.from_ym}-01`);
      p.set("to_date", new Date(ty, tm, 0).toISOString().slice(0, 10));
    } else if (pp.from_date && pp.to_date) {
      p.set("from_date", pp.from_date);
      p.set("to_date", pp.to_date);
    }
    if (oem) p.set("oem", oem);
    if (mode) p.set("contact_mode", mode);
    if (qDeb) p.set("q", qDeb);
    return p;
  }, [period.mode, period.token, period.range, oem, mode, qDeb]);

  useEffect(() => { setPage(1); }, [query]);

  useEffect(() => {
    if (!query) { setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    setError("");
    const p = new URLSearchParams(query);
    p.set("page", String(page));
    p.set("per_page", String(perPage));
    fetch(`${API_URL}/oe-network/my-visits?${p.toString()}`, { headers, signal: ctrl.signal })
      .then(async (res) => {
        const d = await res.json().catch(() => null);
        if (!res.ok) throw new Error(d?.detail || "Could not load your visits.");
        return d;
      })
      .then((d) => {
        setRows(d.data ?? []);
        setTotal(d.total ?? 0);
        setSummary(d.summary ?? { visits: 0, calls: 0, dealerships: 0 });
      })
      .catch((e) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Could not load your visits.");
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, page, refresh]);

  const doExport = async (fmt: "csv" | "xlsx") => {
    if (!query) return;
    setExporting(fmt);
    try {
      const res = await fetch(
        `${API_URL}/oe-network/my-visits/export.${fmt}?${query.toString()}`, { headers });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `visit-log_${(salesperson ?? "me").replace(/\s+/g, "_")}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Export failed. Please try again.");
    } finally {
      setExporting(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        {/* No person filter: this tab is one person by definition. */}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={mode} onChange={setMode} options={MODE_OPTS} placeholder="Visits + Calls" />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Dealership, city, state…"
          className="h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-700 outline-none focus:border-brand-orange w-48" />
        <ClearFilters show={hasFilters} onClear={clearFilters} />
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefresh((x) => x + 1)} disabled={loading} />
          <SyncButton onClick={syncAll} syncing={syncing}
            title="Re-pull the log book from Google Sheets" />
          {/* Export, not PDF: the point of this tab is handing the rows to
              somebody else, and a spreadsheet is what they are asked for. */}
          <button onClick={() => doExport("csv")} disabled={exporting !== null || total === 0}
            className="flex items-center gap-1.5 h-9 px-3 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:border-brand-orange hover:text-brand-orange disabled:opacity-50 transition-colors">
            <Download size={12} /> CSV
          </button>
          <button onClick={() => doExport("xlsx")} disabled={exporting !== null || total === 0}
            className="flex items-center gap-1.5 h-9 px-3 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:border-brand-orange hover:text-brand-orange disabled:opacity-50 transition-colors">
            <Download size={12} /> Excel
          </button>
        </FilterActions>
      </FilterBar>

      {scoped && salesperson && (
        <ScopeNote salesperson={salesperson}>
          Every row you have submitted through the visit-log form. New submissions
          appear here after the next sync, not the moment you send them.
        </ScopeNote>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* The tiles cover the period, OEM and search — but NOT the Visit/Calling
            filter, or picking "Visits only" would zero the Calls tile and say
            nothing. */}
        <StatCard label="Visits" value={summary.visits} icon={<Footprints size={16} />} {...KPI.visits} />
        <StatCard label="Calls" value={summary.calls} icon={<Phone size={16} />} {...KPI.calls} />
        <StatCard label="Dealerships" value={summary.dealerships} sub="distinct, in this period"
          icon={<Store size={16} />} {...KPI.reach} />
      </div>

      <div className="bg-white border border-orange-100 rounded-2xl shadow-sm">
        <div className="flex items-center justify-between px-5 pt-5">
          <h3 className="text-sm font-bold text-gray-800">
            My submissions
            <span className="ml-2 text-xs font-medium text-gray-500">
              {total.toLocaleString("en-IN")} {total === 1 ? "entry" : "entries"}
            </span>
          </h3>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs px-4 py-2.5">
            {error}
          </div>
        )}

        <div className="overflow-x-auto p-5 pt-3">
          <table className="w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">
                {COLUMNS.map((c) => (
                  <th key={c.head}
                    className={`py-2 pr-3 border-b border-gray-100 ${c.align === "right" ? "text-right" : ""}`}>
                    {c.head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={COLUMNS.length} className="py-10 text-center">
                  <div className="w-5 h-5 border-2 border-orange-200 border-t-brand-orange rounded-full animate-spin inline-block" />
                </td></tr>
              ) : rows.length === 0 ? (
                /* Distinguishes "nothing in this window" from "nothing at all",
                   and offers the way back out, since a narrow period is the
                   likeliest reason a rep finds this empty. */
                <tr><td colSpan={COLUMNS.length} className="py-10 text-center text-gray-500">
                  {hasFilters ? (
                    <>No visits match these filters.{" "}
                      <button onClick={clearFilters} className="text-brand-orange font-semibold underline">
                        Clear them
                      </button>
                    </>
                  ) : "You have not submitted any visits yet."}
                </td></tr>
              ) : rows.map((r, i) => (
                <tr key={i} className="hover:bg-orange-50/40 align-top">
                  {COLUMNS.map((c) => {
                    const v = c.cell(r);
                    return (
                      <td key={c.head}
                        className={`py-2.5 pr-3 border-b border-gray-50 text-gray-600 ${
                          c.width ?? "whitespace-nowrap"} ${c.align === "right" ? "text-right" : ""}`}>
                        {c.clamp
                          ? <span className="line-clamp-2" title={typeof v === "string" ? v : undefined}>{v}</span>
                          : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 pb-5">
            <p className="text-xs text-gray-500">Page {page} of {totalPages}</p>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="h-8 px-3 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 disabled:opacity-40">
                Previous
              </button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="h-8 px-3 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 disabled:opacity-40">
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
