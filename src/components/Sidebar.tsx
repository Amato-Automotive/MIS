import { useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  TrendingUp,
  BarChart2,
  LogOut,
  UserCircle,
  UserCog,
  Wallet,
  FileSpreadsheet,
  CarFront,
  Globe2,
  Sparkles,
} from "lucide-react";
import { useAuth, UserRole } from "@/context/AuthContext";
import { ModuleKey, canAccessModule } from "@/lib/modules";
import { cn } from "@/lib/utils";

const logoSrc = "/amato-logo.png";

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
  section?: string;
  moduleKey?: ModuleKey; // omitted = always visible to any authenticated user
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    label: "Overview",
    icon: <LayoutDashboard size={16} />,
    path: "/dashboard",
  },
  {
    id: "sales",
    label: "Sales (AFAC)",
    icon: <TrendingUp size={16} />,
    path: "/dashboard/sales",
    section: "MODULES",
    moduleKey: "sales",
  },
  {
    id: "leads",
    label: "Leads Analytics (AFAC)",
    icon: <BarChart2 size={16} />,
    path: "/dashboard/leads",
    moduleKey: "leads",
  },
  {
    id: "finance",
    label: "Finance",
    icon: <Wallet size={16} />,
    path: "/dashboard/finance",
    moduleKey: "finance",
  },
  {
    id: "oe-network",
    label: "OE Network",
    icon: <CarFront size={16} />,
    path: "/dashboard/oe-network",
    moduleKey: "oe_network",
  },
  {
    id: "export",
    label: "Export",
    icon: <Globe2 size={16} />,
    path: "/dashboard/export",
    moduleKey: "export",
  },
  {
    id: "assistant",
    label: "AI Assistant",
    icon: <Sparkles size={16} />,
    path: "/dashboard/assistant",
    moduleKey: "chat",
  },
  {
    id: "users",
    label: "Users",
    icon: <UserCog size={16} />,
    path: "/dashboard/users",
    section: "ADMIN",
  },
  {
    id: "sheet-guide",
    label: "Connect a Sheet",
    icon: <FileSpreadsheet size={16} />,
    path: "/dashboard/sheet-guide",
    section: "HELP",
  },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!user) return false;
    if (item.id === "users") return user.role === "superadmin";
    // Only useful to people who actually have a sheet-backed module.
    if (item.id === "sheet-guide")
      return (
        canAccessModule(user, "sales") ||
        canAccessModule(user, "finance") ||
        canAccessModule(user, "oe_network")
      );
    if (!item.moduleKey) return true;
    return canAccessModule(user, item.moduleKey);
  });

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const roleLabel: Record<UserRole, string> = {
    superadmin: "Super Admin",
    management: "Management",
    sales_head: "Sales Head",
    leads_head: "Leads Head",
    sales_rep: "Sales Rep",
    staff: "Staff",
  };

  return (
    <aside
      className="no-print relative flex flex-col h-full bg-white rounded-[32px] border border-orange-100 overflow-hidden"
      style={{ width: 280, boxShadow: "0 10px 40px rgba(0,0,0,0.04)", flexShrink: 0 }}
    >
      {/* Logo — centred. The BETA chip rides beside it: the app is still being
          tested, and the people reading these numbers were not in the room when
          it was built. Delete this span when it ships for real. */}
      <div className="flex items-center justify-center gap-2 h-20 border-b border-orange-50 shrink-0 px-4">
        <img src={logoSrc} alt="Amato Automotive" className="h-10 w-auto" />
        <span
          className="text-[9px] font-bold uppercase tracking-[0.15em] px-1.5 py-0.5 rounded-md text-amber-700 bg-amber-50 border border-amber-200"
          title="Still being tested — figures may change."
        >
          Beta
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-0.5">
        {visibleItems.map((item, idx) => {
          const isActive =
            item.path === "/dashboard"
              ? location.pathname === "/dashboard"
              : location.pathname.startsWith(item.path);

          const prevItem = visibleItems[idx - 1];
          const showSection = item.section && item.section !== prevItem?.section;

          return (
            <div key={item.id}>
              {showSection && <p className="nav-section-label">{item.section}</p>}
              <button
                id={`nav-${item.id}`}
                onClick={() => navigate(item.path)}
                className={cn("nav-item w-full", isActive && "active")}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="text-sm font-medium">{item.label}</span>
              </button>
            </div>
          );
        })}
      </nav>

      {/* Bottom — user card + sign out */}
      <div className="px-3 pb-4 border-t border-orange-50 pt-3 shrink-0 flex flex-col gap-2">
        {/* User card — click to go to profile */}
        <button
          onClick={() => navigate("/dashboard/profile")}
          className={cn(
            "flex items-center gap-3 rounded-2xl p-3 w-full text-left transition-colors hover:bg-orange-50",
            location.pathname === "/dashboard/profile" ? "bg-orange-50" : "bg-orange-50/40"
          )}
        >
          <div className="w-8 h-8 rounded-xl bg-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
            {user?.name?.charAt(0) ?? "U"}
          </div>
          <div className="flex-1 overflow-hidden min-w-0">
            <p className="text-xs font-bold text-gray-800 truncate">{user?.name}</p>
            <p className="text-[10px] text-orange-500 font-bold uppercase tracking-wider">
              {user ? roleLabel[user.role] : ""}
            </p>
          </div>
          <UserCircle size={14} className="shrink-0 text-gray-400" />
        </button>

        {/* Sign Out button */}
        <button
          onClick={handleLogout}
          className="flex items-center justify-center gap-2 w-full h-9 rounded-xl text-xs font-bold uppercase tracking-wider text-red-400 border border-red-100 bg-red-50/60 hover:bg-red-100 hover:text-red-600 hover:border-red-200 transition-all duration-200"
        >
          <LogOut size={13} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
