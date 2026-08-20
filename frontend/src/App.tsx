import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users as UsersIcon,
  Layers,
  Megaphone,
  FileText,
  Zap,
  Upload,
  Plug,
  History,
  UserCog,
  Settings as SettingsIcon,
  UserCircle,
  LogOut,
  Search,
} from "lucide-react";
import { useAuth } from "./context/AuthContext";
import Login from "./pages/Login";
import Clients from "./pages/Clients";
import ClientProfile from "./pages/ClientProfile";
import Segments from "./pages/Segments";
import CampaignList from "./pages/campaigns/CampaignList";
import CampaignWizard from "./pages/campaigns/CampaignWizard";
import CampaignReport from "./pages/campaigns/CampaignReport";
import Integrations from "./pages/Integrations";
import Automations from "./pages/Automations";
import AuditLog from "./pages/AuditLog";
import Templates from "./pages/Templates";
import Imports from "./pages/Imports";
import Settings from "./pages/Settings";
import Account from "./pages/Account";
import Users from "./pages/Users";
import NotificationBell from "./components/NotificationBell";
import { SidebarNav, type NavGroupData, type NavItemData } from "./components/ui/dashboard-sidebar";

// Carregado sob demanda: é a única tela que usa a lib de gráficos (recharts), que sozinha
// pesa mais que o resto do bundle inteiro — não faz sentido baixá-la em toda página do app.
const Dashboard = lazy(() => import("./pages/Dashboard"));

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Senha resetada por um Admin: força a troca antes de liberar o resto do sistema.
  if (user.mustChangePassword && window.location.pathname !== "/account") {
    return <Navigate to="/account" replace />;
  }
  return children;
}

function Layout({ children }: { children: JSX.Element }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const groups: NavGroupData[] = [
    {
      items: [
        { id: "dashboard", title: "Dashboard", icon: LayoutDashboard, path: "/" },
        { id: "search", title: "Buscar", icon: Search, shortcut: "⌘K" },
      ],
    },
    {
      heading: "Relacionamento",
      items: [
        { id: "clients", title: "Base de clientes", icon: UsersIcon, path: "/clients" },
        { id: "segments", title: "Segmentos", icon: Layers, path: "/segments" },
      ],
    },
    {
      heading: "Comunicação",
      items: [
        { id: "campaigns", title: "Campanhas", icon: Megaphone, path: "/campaigns" },
        { id: "templates", title: "Templates", icon: FileText, path: "/templates" },
        { id: "automations", title: "Automações", icon: Zap, path: "/automations" },
      ],
    },
    {
      heading: "Dados",
      items: [
        { id: "imports", title: "Importações", icon: Upload, path: "/imports" },
        { id: "integrations", title: "Integrações", icon: Plug, path: "/integrations" },
        { id: "audit", title: "Auditoria", icon: History, path: "/audit" },
      ],
    },
  ];

  if (user?.role === "ADMIN") {
    groups.push({
      heading: "Administração",
      items: [{ id: "users", title: "Usuários", icon: UserCog, path: "/users" }],
    });
  }

  const bottomItems: NavItemData[] = [
    { id: "account", title: "Minha conta", icon: UserCircle, path: "/account" },
    { id: "settings", title: "Configurações", icon: SettingsIcon, path: "/settings" },
    { id: "logout", title: "Sair", icon: LogOut },
  ];

  const allItems = [...groups.flatMap((g) => g.items), ...bottomItems];
  const activeId =
    allItems
      .filter((i) => i.path)
      .sort((a, b) => (b.path as string).length - (a.path as string).length)
      .find((i) => i.path === "/" ? location.pathname === "/" : location.pathname.startsWith(i.path as string))
      ?.id ?? "dashboard";

  function handleSelect(item: NavItemData) {
    if (item.id === "logout") {
      logout();
      return;
    }
    if (item.path) navigate(item.path);
  }

  return (
    <div className="app-shell">
      <div className="dsb-sidebar-wrap">
        <SidebarNav
          groups={groups}
          bottomItems={bottomItems}
          activeId={activeId}
          onSelect={handleSelect}
          brandTitle="CRM TopConta"
          brandSubtitle={user?.name}
        />
      </div>
      <div className="main">
        <div className="topbar">
          <div />
          <div style={{ display: "flex", alignItems: "center" }}>
            <NotificationBell />
            <span style={{ marginRight: 12, fontSize: 14, color: "var(--text-muted)" }}>
              {user?.name} · {user?.role}
            </span>
            <button className="btn secondary" onClick={logout}>
              Sair
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route
                  path="/"
                  element={
                    <Suspense fallback={<div>Carregando...</div>}>
                      <Dashboard />
                    </Suspense>
                  }
                />
                <Route path="/clients" element={<Clients />} />
                <Route path="/clients/:id" element={<ClientProfile />} />
                <Route path="/segments" element={<Segments />} />
                <Route path="/campaigns" element={<CampaignList />} />
                <Route path="/campaigns/new" element={<CampaignWizard />} />
                <Route path="/campaigns/:id/report" element={<CampaignReport />} />
                <Route path="/templates" element={<Templates />} />
                <Route path="/automations" element={<Automations />} />
                <Route path="/imports" element={<Imports />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/audit" element={<AuditLog />} />
                <Route path="/users" element={<Users />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/account" element={<Account />} />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
