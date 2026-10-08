// Export › Data Source Sheet — register the export team's workbook, sync it,
// and read back what the last syncs complained about. Management only: the
// API refuses add/remove to anyone else, and removing the sheet wipes the
// pipeline.
//
// The sync warnings are shown in full, not just counted, because they are the
// list of things the export team has to fix in their sheet.
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, History, CheckCircle2, XCircle, Clock, ExternalLink } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/format";
import Explain from "../oe-network/dealers/Explain";
import { API_URL, Panel } from "./shared";

interface Source {
  id: string; sheet_id: string; label: string; created_at: string | null;
  last_synced_at: string | null; last_sync_status: string | null;
}
interface HistoryItem {
  id: string; status: string; synced_at: string | null;
  rows_inserted: number | null; rows_deleted: number | null; warnings: string[];
}

const inputClass =
  "h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all";

function statusIcon(status: string | null) {
  if (status === "Done") return <CheckCircle2 size={13} className="text-green-500" />;
  if (status === "Failed") return <XCircle size={13} className="text-red-500" />;
  if (status) return <Clock size={13} className="text-amber-500" />;
  return null;
}

export default function SheetTab({ headers, onSync, syncing, onChanged }: {
  headers: Record<string, string>; onSync: () => Promise<void>; syncing: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [sources, setSources] = useState<Source[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, h] = await Promise.all([
      fetch(`${API_URL}/export/sheet-sources`, { headers }),
      fetch(`${API_URL}/export/sync-history`, { headers }),
    ]);
    if (s.ok) setSources(await s.json());
    if (h.ok) {
      const items: HistoryItem[] = await h.json();
      setHistory(items);
      // The newest run's warnings open by default — they are why anyone
      // comes to this tab.
      setOpenLog((cur) => cur ?? items[0]?.id ?? null);
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);
  // Re-read after a sync finishes, wherever it was pressed from.
  useEffect(() => { if (!syncing) load(); }, [syncing, load]);

  const add = async () => {
    setAdding(true);
    try {
      const res = await fetch(`${API_URL}/export/sheet-sources`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: link.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Could not register the sheet");
      setLink("");
      await load();
      await onSync();
    } catch (e) {
      toast.error("Could not add sheet", e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (s: Source) => {
    if (!window.confirm(`Remove "${s.label}" and every synced lead? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_URL}/export/sheet-sources/${s.id}`, { method: "DELETE", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Delete failed");
      toast.success("Sheet removed", `${data.rows_deleted} leads cleared`);
      await load();
      onChanged();
    } catch (e) {
      toast.error("Could not remove sheet", e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const source = sources[0];

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Export Leads Sheet"
        sub="The export team’s workbook. Only the “Leads” and “Activity” tabs are read — every other tab is ignored.">
        {source ? (
          <div className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <a href={`https://docs.google.com/spreadsheets/d/${source.sheet_id}`} target="_blank" rel="noreferrer"
                className="text-xs font-semibold text-gray-700 hover:text-brand-orange inline-flex items-center gap-1">
                {source.label} <ExternalLink size={11} />
              </a>
              <p className="text-[10px] text-gray-500 flex items-center gap-1">
                {statusIcon(source.last_sync_status)}
                {source.last_synced_at ? `Last synced ${formatDate(source.last_synced_at)}` : "Never synced"}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={onSync} disabled={syncing}
                className="flex items-center gap-1.5 text-[11px] font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-50 transition-all">
                {syncing
                  ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
                  : <><RefreshCw size={11} /> Sync Now</>}
              </button>
              <button onClick={() => remove(source)} disabled={deleting} title="Remove this sheet"
                className="flex items-center text-gray-500 hover:text-red-500 p-1.5 rounded-lg border border-transparent hover:border-red-100 transition-all disabled:opacity-40">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex gap-2">
            <input value={link} onChange={(e) => setLink(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…" className={`${inputClass} flex-1`} />
            <button onClick={add} disabled={adding || !link.trim()}
              className="flex items-center gap-1.5 text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
              <Plus size={13} /> {adding ? "Adding…" : "Add & Sync"}
            </button>
          </div>
        )}
        <Explain>
          The sheet must be shared <b className="text-gray-700">Restricted</b>, with the MIS service
          account added as a viewer — never &ldquo;anyone with the link&rdquo;. Columns are found by their
          header names, so the team may reorder them, but renaming one makes it read as empty (a sync
          says so when it happens). A sync that finds no leads fails and keeps the previous data rather
          than emptying the pipeline.
        </Explain>
      </Panel>

      <Panel title="Sync History" sub="The last five runs. Warnings are problems in the sheet itself — pass them to the export team.">
        {history.length === 0 ? (
          <p className="text-xs text-gray-500 py-3">No syncs yet.</p>
        ) : (
          <div className="flex flex-col">
            {history.map((h) => (
              <div key={h.id} className="border-b border-gray-50 last:border-0">
                <button onClick={() => setOpenLog(openLog === h.id ? null : h.id)}
                  className="w-full flex items-center gap-3 py-2.5 text-left text-xs hover:bg-orange-50/40 rounded-lg px-1 -mx-1">
                  <History size={13} className="text-gray-400 shrink-0" />
                  <span className="flex items-center gap-1 w-20 shrink-0">
                    {statusIcon(h.status)}<span className="text-gray-600">{h.status}</span>
                  </span>
                  <span className="text-gray-500 flex-1">{h.synced_at ? formatDate(h.synced_at) : "—"}</span>
                  <span className="text-gray-600 w-24 text-right">{h.rows_inserted ?? 0} leads</span>
                  <span className={`w-28 text-right ${h.warnings.length ? "text-amber-600 font-semibold" : "text-gray-500"}`}>
                    {h.warnings.length ? `${h.warnings.length} warning${h.warnings.length === 1 ? "" : "s"}` : "no warnings"}
                  </span>
                </button>
                {openLog === h.id && h.warnings.length > 0 && (
                  <div className="mb-3 bg-amber-50 border border-amber-100 rounded-xl p-3">
                    {h.warnings.map((w, i) => <p key={i} className="text-[11px] text-amber-700">{w}</p>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
