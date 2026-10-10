import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { api } from "../api/client";

interface Frescor {
  status: "OK" | "DESATUALIZADO" | "SEM_DADOS";
  mensagem: string | null;
}

/** Aviso quando o extrato de compras está parado: recorrência e dias sem uso deixam de ser confiáveis. */
export default function FrescorExtrato() {
  const [f, setF] = useState<Frescor | null>(null);
  useEffect(() => {
    api<Frescor>("/dashboard/frescor").then(setF).catch(() => {});
  }, []);
  if (!f || f.status === "OK" || !f.mensagem) return null;
  return (
    <div className="card" style={{ borderLeft: "4px solid #d97706", marginBottom: 12, display: "flex", gap: 10, alignItems: "center" }}>
      <AlertTriangle size={18} color="#d97706" />
      <span style={{ fontSize: 13 }}>
        {f.mensagem} <Link to="/imports">Ir para Importações</Link>
      </span>
    </div>
  );
}
