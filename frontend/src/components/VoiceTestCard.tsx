import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface Status {
  twilio: boolean;
  xai: boolean;
  numeroTeste: string | null;
  pronto: boolean;
  maxSegundos: number;
}

/** Fase 1 da ligação com IA de voz: liga para o celular de teste (configurado no servidor) para avaliar português, atraso e custo. */
export default function VoiceTestCard() {
  const { user } = useAuth();
  const [st, setSt] = useState<Status | null>(null);
  const [nome, setNome] = useState("Maria");
  const [saldo, setSaldo] = useState("250");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  useEffect(() => {
    api<Status>("/voice/status").then(setSt).catch(() => setSt(null));
  }, []);

  if (!st) return null;

  async function ligar() {
    setBusy(true);
    setMsg(null);
    try {
      const saldoNum = saldo.trim() === "" ? null : Number(saldo.replace(",", "."));
      const r = await api<{ destino: string }>("/voice/test-call", { method: "POST", body: { nome, saldo: saldoNum } });
      setMsg({ tipo: "ok", texto: `Ligando para ${r.destino}. Atenda e converse com o agente (até ${st!.maxSegundos} segundos).` });
    } catch (e: any) {
      setMsg({ tipo: "erro", texto: e.message || "Não consegui iniciar a ligação" });
    } finally {
      setBusy(false);
    }
  }

  const item = (ok: boolean, rotulo: string) => (
    <span style={{ marginRight: 14 }}>
      <strong style={{ color: ok ? "var(--success, #35c17a)" : "var(--warning)" }}>{ok ? "●" : "○"}</strong> {rotulo}
    </span>
  );

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Ligação com IA de voz (teste)</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Liga para o <strong>celular de teste</strong> com o agente de voz da xAI, usando o Twilio. Nesta fase não liga para clientes: serve para avaliar o português,
        o atraso na primeira fala e o custo por minuto.
      </p>
      <p style={{ fontSize: 13 }}>
        {item(st.twilio, "Twilio")}
        {item(st.xai, "xAI")}
        {item(!!st.numeroTeste, `Celular de teste${st.numeroTeste ? ` (${st.numeroTeste})` : ""}`)}
      </p>
      {!st.pronto && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Faltam variáveis no projeto do backend na Vercel: <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code>, <code>TWILIO_VOICE_NUMBER</code>,{" "}
          <code>XAI_API_KEY</code> e <code>VOICE_TEST_NUMBER</code> (depois, um novo deploy).
        </p>
      )}
      {user?.role === "ADMIN" && (
        <>
          <div className="form-row"><label>Nome que o agente vai usar</label><input value={nome} onChange={(e) => setNome(e.target.value)} /></div>
          <div className="form-row"><label>Saldo disponível a falar (R$, vazio = não citar valor)</label><input value={saldo} onChange={(e) => setSaldo(e.target.value)} /></div>
          <button className="btn" disabled={busy || !st.pronto} onClick={ligar}>{busy ? "Ligando..." : "Ligar para o celular de teste"}</button>
        </>
      )}
      {msg && <p className={msg.tipo === "erro" ? "error-text" : ""} style={{ marginTop: 10, fontSize: 13 }}>{msg.texto}</p>}
    </div>
  );
}
