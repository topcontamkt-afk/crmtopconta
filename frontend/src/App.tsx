import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Clients from "./pages/Clients";
import ClientProfile from "./pages/ClientProfile";
import Segments from "./pages/Segments";
import CampaignList from "./pages/campaigns/CampaignList";
import CampaignWizard from "./pages/campaigns/CampaignWizard";
import CampaignReport from "./pages/campaigns/CampaignReport";
import Integrations from "./pages/Integrations";
import Automations from "./pages/Automations";
import AuditLog from "./pages/AuditLog";

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Layout({ children }: { children: JSX.Element }) {
  const { user, logout } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>CRM TopConta</h1>
        <nav>
          <NavLink to="/">Dashboard</NavLink>
          <NavLink to="/clients">Base de clientes</NavLink>
          <NavLink to="/segments">Segmentos</NavLink>
          <NavLink to="/campaigns">Campanhas</NavLink>
          <NavLink to="/automations">Automações</NavLink>
          <NavLink to="/integrations">Integrações</NavLink>
          <NavLink to="/audit">Auditoria</NavLink>
        </nav>
      </aside>
      <div className="main">
        <div className="topbar">
          <div />
          <div>
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
                <Route path="/" element={<Dashboard />} />
                <Route path="/clients" element={<Clients />} />
                <Route path="/clients/:id" element={<ClientProfile />} />
                <Route path="/segments" element={<Segments />} />
                <Route path="/campaigns" element={<CampaignList />} />
                <Route path="/campaigns/new" element={<CampaignWizard />} />
                <Route path="/campaigns/:id/report" element={<CampaignReport />} />
                <Route path="/automations" element={<Automations />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/audit" element={<AuditLog />} />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
