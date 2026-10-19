export type ModuleKey = "sales" | "leads" | "finance" | "oe_network" | "export" | "chat";

export const ALL_MODULES: ModuleKey[] = ["sales", "leads", "finance", "oe_network", "export", "chat"];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  sales: "Sales (AFAC)",
  leads: "Leads Analytics (AFAC)",
  finance: "Finance",
  oe_network: "OE Network",
  export: "Export",
  chat: "AI Assistant",
};

/** Single source of truth for module gating — used by the sidebar and the overview launcher. */
export function canAccessModule(
  user: { role: string; modules?: string[] } | null | undefined,
  moduleKey: ModuleKey
): boolean {
  if (!user) return false;
  return user.role === "superadmin" || (user.modules ?? []).includes(moduleKey);
}
