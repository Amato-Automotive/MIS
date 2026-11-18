// The admin-managed list of finance company groups (Finance > Data Sources).
// One shared fetch shape for the All Companies filter and the group manager, so
// neither keeps its own copy of what the groups are.
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export interface CompanyGroupInfo {
  key: string;
  label: string;
  sort_order: number;
  /** Companies tagged with it; null unless the caller is an admin. */
  companies: number | null;
}

export function useCompanyGroups(refreshNonce = 0) {
  const { token } = useAuth();
  const [groups, setGroups] = useState<CompanyGroupInfo[]>([]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/finance/groups`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setGroups(await res.json());
    } catch { /* the filter simply offers no groups */ }
  }, [token]);

  useEffect(() => { reload(); }, [reload, refreshNonce]);

  const options = groups.map((g) => ({ value: g.key, label: g.label }));
  const labelOf = (key: string | null | undefined) =>
    groups.find((g) => g.key === key)?.label ?? key ?? "";
  return { groups, options, labelOf, reload };
}
