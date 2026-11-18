// Admin CRUD for the finance company groups (Finance > Data Sources).
// A group's key is fixed when it is created (companies point at it), so Rename
// changes only the label people read. Deleting a group does not delete or hide
// any company: they simply go back to "not yet categorised".
import { useState } from "react";
import { Plus, Pencil, Trash2, Check, X, ChevronUp, ChevronDown } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import type { CompanyGroupInfo } from "./useCompanyGroups";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface Props {
  groups: CompanyGroupInfo[];
  /** Re-fetch groups AND the companies, since a delete untags companies. */
  onChanged: () => void;
}

export default function CompanyGroupsManager({ groups, onChanged }: Props) {
  const { token } = useAuth();
  const toast = useToast();
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(`${API_URL}/finance/groups${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  };

  const run = async (fn: () => Promise<void>, failTitle: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(failTitle, e instanceof Error ? e.message : "Please try again.");
    } finally {
      // Reload even after a failure: a half-finished reorder must not leave the
      // list showing an order the server does not have.
      onChanged();
      setBusy(false);
    }
  };

  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    run(async () => {
      await call("", "POST", { label });
      setNewLabel("");
    }, "Couldn't add group");
  };

  const saveRename = (g: CompanyGroupInfo) => {
    const label = editLabel.trim();
    if (!label || label === g.label) {
      setEditKey(null);
      return;
    }
    run(async () => {
      await call(`/${g.key}`, "PATCH", { label });
      setEditKey(null);
    }, "Couldn't rename group");
  };

  const remove = (g: CompanyGroupInfo) => {
    const n = g.companies ?? 0;
    const msg = n > 0
      ? `Delete the "${g.label}" group?\n\n${n} ${n === 1 ? "company is" : "companies are"} in it and will become "Not set". No company or finance data is deleted.`
      : `Delete the "${g.label}" group?`;
    if (!window.confirm(msg)) return;
    run(async () => {
      const r = await call(`/${g.key}`, "DELETE");
      toast.success("Group deleted", r.companies_untagged > 0
        ? `${r.companies_untagged} ${r.companies_untagged === 1 ? "company is" : "companies are"} now not set.`
        : `"${g.label}" was removed.`);
    }, "Couldn't delete group");
  };

  // Order is display order everywhere the list appears. Positions are rewritten
  // 1..n for the whole list, so a move never depends on the old numbers being
  // distinct (they can tie after groups are added and deleted).
  const move = (i: number, dir: -1 | 1) => {
    if (!groups[i + dir]) return;
    const order = groups.map((g) => g.key);
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    run(async () => {
      for (let p = 0; p < order.length; p++) {
        const g = groups.find((x) => x.key === order[p])!;
        if (g.sort_order !== p + 1) await call(`/${g.key}`, "PATCH", { sort_order: p + 1 });
      }
    }, "Couldn't reorder groups");
  };

  return (
    <div className="no-print bg-white border border-[#EAE3D6] rounded-2xl p-5 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-bold text-gray-800">Company groups — manage</h2>
        <p className="text-[11px] text-gray-500 mt-0.5">
          The groups a company can be placed in, and what the All Companies view filters on. Renaming changes only the name shown;
          deleting a group leaves its companies in “Not set”.
        </p>
      </div>

      <div className="flex flex-col divide-y divide-gray-100 border border-gray-100 rounded-xl">
        {groups.length === 0 && (
          <div className="px-3 py-3 text-[13px] text-gray-500">No groups yet — add the first one below.</div>
        )}
        {groups.map((g, i) => (
          <div key={g.key} className="flex items-center justify-between gap-3 px-3 py-2">
            {editKey === g.key ? (
              <input
                autoFocus
                value={editLabel}
                maxLength={80}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRename(g);
                  if (e.key === "Escape") setEditKey(null);
                }}
                className="h-8 flex-1 min-w-0 px-2 rounded-lg border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              />
            ) : (
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-gray-800 truncate">{g.label}</div>
                <div className="text-[11px] text-gray-500">
                  {g.companies ?? 0} {g.companies === 1 ? "company" : "companies"}
                </div>
              </div>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {editKey === g.key ? (
                <>
                  <button onClick={() => saveRename(g)} disabled={busy} title="Save"
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-green-600 hover:border-green-200 disabled:opacity-50">
                    <Check size={13} />
                  </button>
                  <button onClick={() => setEditKey(null)} title="Cancel"
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-700">
                    <X size={13} />
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => move(i, -1)} disabled={busy || i === 0} title="Move up"
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-800 disabled:opacity-30">
                    <ChevronUp size={13} />
                  </button>
                  <button onClick={() => move(i, 1)} disabled={busy || i === groups.length - 1} title="Move down"
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-800 disabled:opacity-30">
                    <ChevronDown size={13} />
                  </button>
                  <button onClick={() => { setEditKey(g.key); setEditLabel(g.label); }} disabled={busy} title="Rename"
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-800 disabled:opacity-50">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => remove(g)} disabled={busy} title="Delete"
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200 disabled:opacity-50">
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={newLabel}
          maxLength={80}
          placeholder="New group name, e.g. Export Group"
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          className="h-10 flex-1 min-w-[200px] px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all"
        />
        <button onClick={add} disabled={busy || !newLabel.trim()}
          className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
          <Plus size={13} /> Add group
        </button>
      </div>
    </div>
  );
}
