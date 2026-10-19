import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import LoginPage from "@/pages/LoginPage";
import ResetPasswordPage from "@/pages/ResetPasswordPage";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage";
import DashboardLayout from "@/layouts/DashboardLayout";
import OverviewPage from "@/pages/OverviewPage";
import SalesPage from "@/pages/SalesPage";
import FinancePage from "@/pages/FinancePage";
import OENetworkPage from "@/pages/OENetworkPage";
import LeadsPage from "@/pages/LeadsPage";
import SheetGuidePage from "@/pages/SheetGuidePage";
import ExportPage from "@/pages/export/ExportPage";
import AssistantPage from "@/pages/AssistantPage";
import { ToastProvider } from "@/components/ui/Toast";
import ProfilePage from "@/pages/ProfilePage";
import UsersPage from "@/pages/UsersPage";
import VisitLogFormPage from "@/pages/VisitLogFormPage";
import MyVisitsPage from "@/pages/MyVisitsPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, mustChangePassword } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/reset-password" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, mustChangePassword } = useAuth();
  if (isAuthenticated && mustChangePassword) return <Navigate to="/reset-password" replace />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function ResetPasswordRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      {/* Public — shared with OEM salespeople by link. No auth, no dashboard. */}
      <Route path="/visit-log" element={<VisitLogFormPage />} />
      {/* Public — ASM self-service, OTP-only login, own data only. No dashboard. */}
      <Route path="/my-visits" element={<MyVisitsPage />} />
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <PublicRoute>
            <ForgotPasswordPage />
          </PublicRoute>
        }
      />
      <Route
        path="/reset-password"
        element={
          <ResetPasswordRoute>
            <ResetPasswordPage />
          </ResetPasswordRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="sales" element={<SalesPage />} />
        <Route path="finance" element={<FinancePage />} />
        <Route path="oe-network" element={<OENetworkPage />} />
        <Route path="leads" element={<LeadsPage />} />
        {/* Upload is now a tab inside Leads; keep the old path working for bookmarks. */}
        <Route path="leads/upload" element={<Navigate to="/dashboard/leads" replace />} />
        <Route path="sheet-guide" element={<SheetGuidePage />} />
        <Route path="export" element={<ExportPage />} />
        <Route path="assistant" element={<AssistantPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
