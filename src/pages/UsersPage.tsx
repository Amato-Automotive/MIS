import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  UserPlus, Search, ShieldCheck, UserCheck, UserX, KeyRound, Settings,
  X, Eye, EyeOff, RefreshCw as Shuffle, Copy, Check, AlertCircle, Users as UsersIcon, Trash2,
} from "lucide-react";
import { useAuth, UserRole } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { ROLE_LABELS, ROLE_COLORS, ALL_ROLES } from "@/lib/roles";
import { ALL_MODULES, MODULE_LABELS, ModuleKey } from "@/lib/modules";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface AppUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  department: string | null;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string | null;
  modules: string[];
  oe_salesperson?: string | null;
}

interface FinanceCompany {
  id: string;
  label: string;
}

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } };

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export default function UsersPage() {
  const { user: me, token } = useAuth();
  const toast = useToast();
  const headers = { Authorization: `Bearer ${token}` };

  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "">("");
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [justCreated, setJustCreated] = useState<{ email: string; password: string } | null>(null);
  const [accessUser, setAccessUser] = useState<AppUser | null>(null);

  const isSuperadmin = me?.role === "superadmin";

  const fetchUsers = () => {
    setLoading(true);
    fetch(`${API_URL}/users/`, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setUsers)
      .catch((e: Error) => toast.error("Couldn't load users", e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { if (token && isSuperadmin) fetchUsers(); }, [token, isSuperadmin]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter && u.role !== roleFilter) return false;
      if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, search, roleFilter]);

  const kpis = [
    { id: "users-total", label: "Total Users", value: users.length, icon: <UsersIcon size={18} />, color: "#3b82f6", bg: "#eff6ff" },
    { id: "users-active", label: "Active", value: users.filter((u) => u.is_active).length, icon: <UserCheck size={18} />, color: "#22c55e", bg: "#f0fdf4" },
    { id: "users-inactive", label: "Inactive", value: users.filter((u) => !u.is_active).length, icon: <UserX size={18} />, color: "#ef4444", bg: "#fef2f2" },
    { id: "users-pending-reset", label: "Pending Reset", value: users.filter((u) => u.must_change_password).length, icon: <KeyRound size={18} />, color: "#f59e0b", bg: "#fffbeb" },
  ];

  const toggleActive = async (u: AppUser) => {
    setPendingToggle(u.id);
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_active: !x.is_active } : x)));
    try {
      const res = await fetch(`${API_URL}/users/${u.id}/toggle-active`, { method: "PATCH", headers });
      if (!res.ok) throw new Error();
    } catch {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_active: u.is_active } : x)));
      toast.error(
        `Couldn't ${u.is_active ? "deactivate" : "activate"} ${u.name}`,
        "The change has been reverted. Please try again."
      );
    } finally {
      setPendingToggle(null);
    }
  };

  const deleteUser = async (u: AppUser) => {
    const confirmed = window.confirm(
      `Permanently delete "${u.name}" (${u.email})?\n\n` +
        `This cannot be undone. Their account and all module/company access will be removed.\n\n` +
        `Data they uploaded or synced (leads, sheets, history) is kept, but will no longer show them as the owner.\n\n` +
        `If you only want to block sign-in, use Deactivate instead — that's reversible.`
    );
    if (!confirmed) return;

    setPendingDelete(u.id);
    try {
      const res = await fetch(`${API_URL}/users/${u.id}`, { method: "DELETE", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Delete failed (HTTP ${res.status})`);
      }
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      toast.success("User deleted", `${u.name} has been permanently removed.`);
    } catch (e) {
      toast.error("Couldn't delete user", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setPendingDelete(null);
    }
  };

  if (!isSuperadmin) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="card-premium p-8 flex flex-col items-center gap-3 text-center max-w-sm">
          <div className="w-12 h-12 rounded-2xl bg-red-50 text-red-400 flex items-center justify-center">
            <ShieldCheck size={22} />
          </div>
          <p className="text-sm font-bold text-gray-700">Access Restricted</p>
          <p className="text-xs text-gray-500">User management is only available to Super Admin accounts.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="page-title-dark">USER</span>
            <span className="page-title-orange">MANAGEMENT</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-0.5 bg-gray-800 rounded" />
            <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
              Create & Manage Team Accounts
            </p>
          </div>
        </div>
        <button
          onClick={() => { setJustCreated(null); setModalOpen(true); }}
          className="flex items-center gap-2 h-11 px-5 rounded-xl text-sm font-bold text-white transition-all duration-200"
          style={{ background: "linear-gradient(135deg,#f46617,#d85512)", boxShadow: "0 4px 16px rgba(244,102,23,0.3)" }}
        >
          <UserPlus size={16} /> Add User
        </button>
      </motion.div>

      {/* Just-created credentials banner */}
      <AnimatePresence>
        {justCreated && (
          <CreatedBanner info={justCreated} onDismiss={() => setJustCreated(null)} />
        )}
      </AnimatePresence>

      {/* KPI Cards */}
      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <motion.div key={kpi.id} variants={item} id={kpi.id} className="kpi-card">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: kpi.bg, color: kpi.color }}>
                {kpi.icon}
              </div>
              <p className="text-xs font-bold text-gray-600">{kpi.label}</p>
            </div>
            <p className="text-2xl font-black text-gray-900 mt-3">{loading ? "—" : kpi.value}</p>
          </motion.div>
        ))}
      </motion.div>

      {/* Toolbar */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full h-10 pl-10 pr-3 rounded-xl border border-gray-200 text-sm text-gray-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as UserRole | "")}
          className="h-10 px-3 rounded-xl border border-gray-200 text-xs font-medium text-gray-700 bg-white outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all cursor-pointer"
        >
          <option value="">All Roles</option>
          {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <button
          onClick={fetchUsers}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-orange-500 transition-colors px-3 h-10 rounded-xl border border-gray-200 hover:border-orange-200"
        >
          <Shuffle size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500 ml-auto">
          {filtered.length} of {users.length} users
        </p>
      </motion.div>

      {/* Table */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="card-premium overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-gray-50 bg-gray-50/50">
                {["User", "Role", "Department", "Access", "Status", "Password", "Created", ""].map((h) => (
                  <th key={h} className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-4 py-3 first:pl-6 last:pr-6">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={8} className="text-center py-8 text-sm text-gray-500">Loading users…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-sm text-gray-500">No users match the current filters.</td></tr>
              ) : filtered.map((u) => {
                const isSelf = u.id === me?.id;
                return (
                  <tr key={u.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center text-xs font-bold shrink-0">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-gray-800 truncate">{u.name}{isSelf && <span className="text-gray-500 font-normal"> (you)</span>}</p>
                          <p className="text-[11px] text-gray-500 truncate">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ${ROLE_COLORS[u.role]}`}>
                        {ROLE_LABELS[u.role]}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-gray-600">{u.department ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3.5">
                      {u.role === "superadmin" ? (
                        <span className="text-[10px] font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">All</span>
                      ) : u.modules.length === 0 ? (
                        <span className="text-[10px] text-gray-500">None</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {u.modules.map((m) => (
                            <span key={m} className="text-[10px] font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">
                              {MODULE_LABELS[m as ModuleKey] ?? m}
                              {m === "oe_network" && u.oe_salesperson
                                ? ` · ${u.oe_salesperson}`
                                : ""}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className={`badge ${u.is_active ? "badge-green" : "badge-red"}`}>
                        {u.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      {u.must_change_password ? (
                        <span className="text-[10px] font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Pending Reset</span>
                      ) : (
                        <span className="text-[10px] text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-gray-500">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                    </td>
                    <td className="px-4 py-3.5 pr-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setAccessUser(u)}
                          disabled={u.role === "superadmin"}
                          title={u.role === "superadmin" ? "Superadmin already has full access" : "Manage module access"}
                          className="w-8 h-8 rounded-xl border border-gray-200 text-gray-500 hover:text-orange-500 hover:border-orange-200 flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Settings size={14} />
                        </button>
                        <button
                          onClick={() => toggleActive(u)}
                          disabled={isSelf || pendingToggle === u.id}
                          title={isSelf ? "You can't deactivate yourself" : u.is_active ? "Deactivate" : "Activate"}
                          className={`text-[11px] font-bold px-3 py-1.5 rounded-xl border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                            u.is_active
                              ? "text-red-500 border-red-200 hover:bg-red-50"
                              : "text-green-600 border-green-200 hover:bg-green-50"
                          }`}
                        >
                          {pendingToggle === u.id ? "…" : u.is_active ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          onClick={() => deleteUser(u)}
                          disabled={isSelf || pendingDelete === u.id}
                          title={isSelf ? "You can't delete your own account" : "Delete permanently"}
                          className="w-8 h-8 rounded-xl border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {pendingDelete === u.id ? (
                            <span className="text-[11px] font-bold">…</span>
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </motion.div>

      <AnimatePresence>
        {modalOpen && (
          <CreateUserModal
            headers={headers}
            onClose={() => setModalOpen(false)}
            onCreated={(u, password) => {
              setUsers((prev) => [u, ...prev]);
              setJustCreated({ email: u.email, password });
              setModalOpen(false);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {accessUser && (
          <ManageAccessModal
            headers={headers}
            targetUser={accessUser}
            onClose={() => setAccessUser(null)}
            onSaved={(modules) => {
              setUsers((prev) => prev.map((x) => (x.id === accessUser.id ? { ...x, modules } : x)));
              setAccessUser(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Shared module/company access checkboxes ───────────────────────────────────
function AccessFields({
  headers, modules, setModules, financeCompanyIds, setFinanceCompanyIds,
  oeSalesperson, setOeSalesperson,
}: {
  headers: Record<string, string>;
  modules: ModuleKey[];
  setModules: (m: ModuleKey[]) => void;
  financeCompanyIds: string[];
  setFinanceCompanyIds: (ids: string[]) => void;
  oeSalesperson: string;
  setOeSalesperson: (name: string) => void;
}) {
  const [companies, setCompanies] = useState<FinanceCompany[] | null>(null);
  const [oeReps, setOeReps] = useState<string[] | null>(null);

  // The names the OE data actually contains. A dropdown rather than a text box
  // on purpose: an unmatched scope fails closed, so one typo would hand the rep
  // an empty module with no error shown anywhere.
  useEffect(() => {
    if (!modules.includes("oe_network") || oeReps !== null) return;
    fetch(`${API_URL}/users/oe-salespersons`, { headers })
      .then((r) => (r.ok ? r.json() : { salespersons: [] }))
      .then((d) => setOeReps(d.salespersons ?? []))
      .catch(() => setOeReps([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules]);

  useEffect(() => {
    if (!modules.includes("finance") || companies !== null) return;
    fetch(`${API_URL}/finance/sheet-sources`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setCompanies(data.map((s: any) => ({ id: s.id, label: s.label }))))
      .catch(() => setCompanies([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules]);

  const toggleModule = (m: ModuleKey) => {
    if (modules.includes(m)) {
      setModules(modules.filter((x) => x !== m));
      // Drop the scope with the access, so re-granting OE later cannot silently
      // reinstate a restriction nobody remembers setting. The backend does the
      // same on save; this keeps the form honest about what it will send.
      if (m === "oe_network") setOeSalesperson("");
    } else setModules([...modules, m]);
  };

  const toggleCompany = (id: string) => {
    if (financeCompanyIds.includes(id)) setFinanceCompanyIds(financeCompanyIds.filter((x) => x !== id));
    else setFinanceCompanyIds([...financeCompanyIds, id]);
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Module Access</label>
      <div className="flex flex-wrap gap-2">
        {ALL_MODULES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => toggleModule(m)}
            className={`text-xs font-bold px-3 py-1.5 rounded-xl border transition-all ${
              modules.includes(m)
                ? "text-orange-600 bg-orange-50 border-orange-200"
                : "text-gray-500 border-gray-200 hover:border-gray-300"
            }`}
          >
            {MODULE_LABELS[m]}
          </button>
        ))}
      </div>
      {modules.includes("chat") && (
        <p className="text-xs text-gray-500">
          The AI Assistant answers only from the modules ticked here, and from the Finance companies and OE
          scope below — it grants no data of its own.
        </p>
      )}

      {modules.includes("oe_network") && (
        <div className="mt-1 flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            OE Network — Whose Data
          </p>
          {oeReps === null ? (
            <p className="text-xs text-gray-500">Loading salespeople…</p>
          ) : (
            <>
              <select
                value={oeSalesperson}
                onChange={(e) => setOeSalesperson(e.target.value)}
                className="text-xs font-medium px-3 py-2 rounded-xl border border-gray-200 bg-white text-gray-700 focus:border-brand-orange focus:outline-none"
              >
                <option value="">Everyone — full OE Network access</option>
                {oeReps.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <p className="text-[11px] leading-relaxed text-gray-500">
                {oeSalesperson
                  ? <>Every OE screen will show <span className="font-semibold text-gray-700">{oeSalesperson}</span>&rsquo;s
                      plans, visits, targets and assigned dealers only. They can still press
                      Sync, but cannot add or remove source sheets.</>
                  : <>This user sees the whole team&rsquo;s OE data. Pick a name to limit them
                      to their own.</>}
              </p>
              {oeReps.length === 0 && (
                <p className="text-[11px] text-gray-500">
                  No salespeople found — sync an OE sheet first, then a name can be picked here.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {modules.includes("finance") && (
        <div className="mt-1 flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Finance — Company Access</p>
          {companies === null ? (
            <p className="text-xs text-gray-500">Loading companies…</p>
          ) : companies.length === 0 ? (
            <p className="text-xs text-gray-500">No Finance companies registered yet. Add one from the Finance page first.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {companies.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCompany(c.id)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-xl border transition-all ${
                    financeCompanyIds.includes(c.id)
                      ? "text-orange-600 bg-orange-50 border-orange-200"
                      : "text-gray-500 border-gray-200 hover:border-gray-300"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Manage Access Modal (existing user) ───────────────────────────────────────
function ManageAccessModal({
  headers, targetUser, onClose, onSaved,
}: {
  headers: Record<string, string>;
  targetUser: AppUser;
  onClose: () => void;
  onSaved: (modules: string[]) => void;
}) {
  const [modules, setModules] = useState<ModuleKey[]>([]);
  const [financeCompanyIds, setFinanceCompanyIds] = useState<string[]>([]);
  const [oeSalesperson, setOeSalesperson] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/users/${targetUser.id}/access`, { headers })
      .then((r) => (r.ok ? r.json() : { modules: [], finance_company_ids: [] }))
      .then((data) => {
        setModules(data.modules ?? []);
        setFinanceCompanyIds(data.finance_company_ids ?? []);
        setOeSalesperson(data.oe_salesperson ?? "");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUser.id]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/users/${targetUser.id}/access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          modules,
          finance_company_ids: financeCompanyIds,
          oe_salesperson: oeSalesperson || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Failed to update access.");
      } else {
        onSaved(data.modules ?? modules);
      }
    } catch {
      setError("Cannot connect to server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black text-gray-900">Manage Access</h2>
            <p className="text-xs text-gray-500">{targetUser.name} · {targetUser.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500"><X size={18} /></button>
        </div>

        {loading ? (
          <p className="text-xs text-gray-500">Loading current access…</p>
        ) : (
          <AccessFields
            headers={headers}
            modules={modules}
            setModules={setModules}
            financeCompanyIds={financeCompanyIds}
            setFinanceCompanyIds={setFinanceCompanyIds}
            oeSalesperson={oeSalesperson}
            setOeSalesperson={setOeSalesperson}
          />
        )}

        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs text-red-600 bg-red-50 border border-red-100">
            <AlertCircle size={13} className="shrink-0" /> {error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={handleSave} disabled={loading || saving}
            className="flex-1 h-11 rounded-xl text-sm font-bold text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg,#f46617,#d85512)", boxShadow: "0 4px 16px rgba(244,102,23,0.3)" }}
          >
            {saving ? "Saving…" : "Save Access"}
          </button>
          <button
            type="button" onClick={onClose}
            className="h-11 px-5 rounded-xl text-sm font-medium text-gray-500 border border-gray-200 hover:border-gray-300 hover:text-gray-700 transition-all"
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Created-credentials banner ────────────────────────────────────────────────
function CreatedBanner({ info, onDismiss }: { info: { email: string; password: string }; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(info.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      <div className="flex items-center gap-3 bg-green-50 border border-green-100 rounded-2xl p-4">
        <ShieldCheck size={18} className="text-green-600 shrink-0" />
        <div className="flex-1 text-xs text-green-800">
          <span className="font-bold">{info.email}</span> created. Share this temporary password — they'll be forced to reset it on first login:{" "}
          <span className="font-mono font-bold bg-white px-2 py-0.5 rounded-lg border border-green-200">{info.password}</span>
        </div>
        <button onClick={copy} className="text-[11px] font-bold text-green-700 hover:text-green-800 flex items-center gap-1 px-2 py-1 shrink-0">
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={onDismiss} className="text-green-400 hover:text-green-600 shrink-0"><X size={15} /></button>
      </div>
    </motion.div>
  );
}

// ── Create User Modal ─────────────────────────────────────────────────────────
function CreateUserModal({
  headers, onClose, onCreated,
}: {
  headers: Record<string, string>;
  onClose: () => void;
  onCreated: (user: AppUser, password: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<UserRole>("staff");
  const [department, setDepartment] = useState("");
  const [modules, setModules] = useState<ModuleKey[]>([]);
  const [financeCompanyIds, setFinanceCompanyIds] = useState<string[]>([]);
  const [oeSalesperson, setOeSalesperson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const valid = name.trim().length > 0 && /\S+@\S+\.\S+/.test(email) && password.length >= 6;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/users/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          role,
          department: department.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Failed to create user.");
        return;
      }
      let grantedModules: string[] = [];
      if (role !== "superadmin" && (modules.length > 0 || financeCompanyIds.length > 0)) {
        const accessRes = await fetch(`${API_URL}/users/${data.id}/access`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            modules,
            finance_company_ids: financeCompanyIds,
            oe_salesperson: oeSalesperson || null,
          }),
        });
        const accessData = await accessRes.json().catch(() => ({}));
        grantedModules = accessData.modules ?? [];
      }
      onCreated({ ...data, modules: grantedModules }, password);
    } catch {
      setError("Cannot connect to server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black text-gray-900">Add New User</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Full Name</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)} required autoFocus
              placeholder="e.g. Priya Sharma"
              className="h-11 px-4 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Email Address</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              placeholder="name@autoformindia.com"
              className="h-11 px-4 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Temporary Password</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                  placeholder="Min. 6 characters"
                  className="h-11 w-full px-4 pr-10 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-500">
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => { setPassword(generatePassword()); setShowPassword(true); }}
                title="Generate password"
                className="h-11 w-11 shrink-0 rounded-xl border border-gray-200 text-gray-500 hover:border-orange-300 hover:text-orange-500 flex items-center justify-center transition-all"
              >
                <Shuffle size={15} />
              </button>
            </div>
            <p className="text-[10px] text-gray-500">User will be forced to set their own password on first login.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Role</label>
            <select
              value={role} onChange={(e) => setRole(e.target.value as UserRole)}
              className="h-11 px-4 rounded-xl border border-gray-200 text-sm text-gray-800 bg-white outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all cursor-pointer"
            >
              {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Department <span className="text-gray-500 normal-case font-normal">(optional)</span>
            </label>
            <input
              value={department} onChange={(e) => setDepartment(e.target.value)}
              placeholder="e.g. Sales, Leads, Operations"
              className="h-11 px-4 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all"
            />
          </div>

          {role === "superadmin" ? (
            <p className="text-[11px] text-gray-500 -mt-1">Superadmin automatically has access to every module.</p>
          ) : (
            <AccessFields
              headers={headers}
              modules={modules}
              setModules={setModules}
              financeCompanyIds={financeCompanyIds}
              setFinanceCompanyIds={setFinanceCompanyIds}
              oeSalesperson={oeSalesperson}
              setOeSalesperson={setOeSalesperson}
            />
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs text-red-600 bg-red-50 border border-red-100">
              <AlertCircle size={13} className="shrink-0" /> {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit" disabled={!valid || saving}
              className="flex-1 h-11 rounded-xl text-sm font-bold text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg,#f46617,#d85512)", boxShadow: "0 4px 16px rgba(244,102,23,0.3)" }}
            >
              {saving ? "Creating…" : "Create User"}
            </button>
            <button
              type="button" onClick={onClose}
              className="h-11 px-5 rounded-xl text-sm font-medium text-gray-500 border border-gray-200 hover:border-gray-300 hover:text-gray-700 transition-all"
            >
              Cancel
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
