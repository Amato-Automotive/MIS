import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { TrendingUp, BarChart2, Wallet, UserCog, ArrowUpRight, LayoutDashboard, CarFront, Globe2, Sparkles } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { ModuleKey, canAccessModule } from "@/lib/modules";

interface ModuleTile {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  color: string;
  bg: string;
  moduleKey?: ModuleKey; // omitted = gated by `adminOnly` instead
  adminOnly?: boolean;
}

const TILES: ModuleTile[] = [
  {
    id: "sales",
    label: "Sales (AFAC)",
    description: "Plant-to-depot dispatch and depot-to-distributor targets",
    icon: <TrendingUp size={24} />,
    path: "/dashboard/sales",
    color: "#f46617",
    bg: "#fff4ed",
    moduleKey: "sales",
  },
  {
    id: "leads",
    label: "Leads Analytics (AFAC)",
    description: "IVR, WhatsApp and Instagram lead pipeline",
    icon: <BarChart2 size={24} />,
    path: "/dashboard/leads",
    color: "#3b82f6",
    bg: "#eff6ff",
    moduleKey: "leads",
  },
  {
    id: "finance",
    label: "Finance",
    description: "Balance Sheet, Profit & Loss and Plant Operations",
    icon: <Wallet size={24} />,
    path: "/dashboard/finance",
    color: "#22c55e",
    bg: "#f0fdf4",
    moduleKey: "finance",
  },
  {
    id: "oe-network",
    label: "OE Network",
    description: "OEM dealership visit plans and field team log book",
    icon: <CarFront size={24} />,
    path: "/dashboard/oe-network",
    color: "#0ea5e9",
    bg: "#f0f9ff",
    moduleKey: "oe_network",
  },
  {
    id: "export",
    label: "Export",
    description: "UK, Europe and Australia lead pipeline",
    icon: <Globe2 size={24} />,
    path: "/dashboard/export",
    color: "#64748b",
    bg: "#f1f5f9",
    moduleKey: "export",
  },
  {
    id: "assistant",
    label: "AI Assistant",
    description: "Ask about your data in plain English",
    icon: <Sparkles size={24} />,
    path: "/dashboard/assistant",
    color: "#f46617",
    bg: "#fff4ed",
    moduleKey: "chat",
  },
  {
    id: "users",
    label: "Users",
    description: "Manage users, module access and company permissions",
    icon: <UserCog size={24} />,
    path: "/dashboard/users",
    color: "#8b5cf6",
    bg: "#f5f3ff",
    adminOnly: true,
  },
];

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] } },
};

function greetingFor(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default function OverviewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const visibleTiles = TILES.filter((tile) =>
    tile.adminOnly ? user?.role === "superadmin" : canAccessModule(user, tile.moduleKey!)
  );

  const firstName = user?.name?.split(" ")[0] ?? "there";

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="flex items-center gap-3">
              <span className="page-title-dark">{greetingFor(new Date().getHours())},</span>
              <span className="page-title-orange">{firstName}</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-8 h-0.5 bg-gray-800 rounded" />
              <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
                {visibleTiles.length > 0 ? "Select a module to get started" : "Welcome"}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">Today</p>
            <p className="text-sm font-bold text-gray-700">
              {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            </p>
          </div>
        </div>
      </motion.div>

      {/* Module tiles */}
      {visibleTiles.length === 0 ? (
        <div className="card-premium p-10 flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-500">
            <LayoutDashboard size={22} />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-700">No modules assigned yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-sm">
              Your account doesn't have access to any modules. Ask a super admin to grant access from the Users page.
            </p>
          </div>
        </div>
      ) : (
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5"
        >
          {visibleTiles.map((tile) => (
            <motion.button
              key={tile.id}
              variants={item}
              onClick={() => navigate(tile.path)}
              className="group card-premium relative overflow-hidden aspect-square p-6 flex flex-col justify-between text-left"
            >
              {/* Accent wash — grows on hover */}
              <div
                className="absolute -top-10 -right-10 w-36 h-36 rounded-full opacity-[0.07] transition-all duration-500 group-hover:opacity-[0.14] group-hover:scale-125"
                style={{ background: tile.color }}
              />

              <div
                className="relative w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-105"
                style={{ background: tile.bg, color: tile.color }}
              >
                {tile.icon}
              </div>

              <div className="relative">
                <p className="text-lg font-black text-gray-900 tracking-tight">{tile.label}</p>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">{tile.description}</p>
                <div
                  className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mt-4"
                  style={{ color: tile.color }}
                >
                  Open
                  <ArrowUpRight
                    size={13}
                    className="transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  />
                </div>
              </div>
            </motion.button>
          ))}
        </motion.div>
      )}
    </div>
  );
}
