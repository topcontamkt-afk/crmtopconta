import { useEffect, useState } from "react";
import { api } from "../api/client";

interface Notification {
  id: string;
  severity: "INFO" | "AVISO" | "ERRO";
  type: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  function load() {
    api<Notification[]>("/notifications?unreadOnly=true").then(setNotifications).catch(() => {});
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  async function markAllRead() {
    await api("/notifications/read-all", { method: "POST" });
    setNotifications([]);
  }

  return (
    <div style={{ position: "relative", display: "inline-block", marginRight: 12 }}>
      <button className="btn secondary" onClick={() => setOpen((o) => !o)}>
        🔔 {notifications.length > 0 ? notifications.length : ""}
      </button>
      {open && (
        <div
          className="card"
          style={{ position: "absolute", right: 0, top: 40, width: 340, zIndex: 10, maxHeight: 400, overflowY: "auto" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <strong>Notificações</strong>
            {notifications.length > 0 && (
              <button className="btn secondary" onClick={markAllRead}>Marcar todas como lidas</button>
            )}
          </div>
          {notifications.length === 0 && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Nenhuma notificação pendente</p>}
          {notifications.map((n) => (
            <div key={n.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span className={`badge ${n.severity === "ERRO" ? "danger" : n.severity === "AVISO" ? "warn" : ""}`}>{n.severity}</span>
              <p style={{ fontSize: 13, margin: "4px 0" }}>{n.message}</p>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(n.createdAt).toLocaleString("pt-BR")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
