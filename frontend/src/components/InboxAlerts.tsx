import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";

interface Resumo {
  naoLidas: number;
  ultima: { id: string; nome: string; preview: string | null; em: string } | null;
}

const POLL_MS = 15000;
const TOAST_MS = 9000;

/** Bipe curto (WebAudio, sem arquivo). Pode ser bloqueado pelo navegador até o primeiro clique: ignora o erro. */
function bipe() {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    /* sem áudio: o aviso visual basta */
  }
}

/**
 * Aviso de mensagem nova do WhatsApp em qualquer tela: balão no canto, bipe, contador no título da aba
 * e, com a aba em segundo plano, notificação do navegador (se a pessoa permitiu). Consulta o resumo
 * leve da Inbox a cada 15 s (a Vercel não mantém conexão aberta). A primeira consulta só marca o que já
 * existia, para não avisar de mensagens antigas ao abrir o sistema.
 */
export default function InboxAlerts() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const naInbox = pathname.startsWith("/inbox");
  const [toast, setToast] = useState<{ id: string; nome: string; preview: string | null } | null>(null);
  const visto = useRef<string | null>(null);
  const baseTitle = useRef(document.title);
  const naInboxRef = useRef(naInbox);
  naInboxRef.current = naInbox;

  useEffect(() => {
    let vivo = true;
    async function consultar() {
      let r: Resumo;
      try {
        r = await api<Resumo>("/inbox/resumo");
      } catch {
        return; // sem acesso à Inbox ou rede fora: sem aviso, sem barulho
      }
      if (!vivo) return;
      document.title = r.naoLidas > 0 ? `(${r.naoLidas}) ${baseTitle.current}` : baseTitle.current;
      const ultima = r.ultima;
      if (visto.current === null) {
        visto.current = ultima?.em ?? "";
        return;
      }
      if (!ultima || ultima.em <= visto.current) return;
      visto.current = ultima.em;
      bipe();
      if (!naInboxRef.current) {
        setToast({ id: ultima.id, nome: ultima.nome, preview: ultima.preview });
        window.setTimeout(() => setToast((t) => (t?.id === ultima.id ? null : t)), TOAST_MS);
      }
      if (document.visibilityState === "hidden" && "Notification" in window && Notification.permission === "granted") {
        try {
          const n = new Notification(`WhatsApp · ${ultima.nome}`, { body: ultima.preview ?? "Nova mensagem", tag: "crm-inbox" });
          n.onclick = () => {
            window.focus();
            navigate("/inbox", { state: { conversaId: ultima.id } });
            n.close();
          };
        } catch {
          /* alguns navegadores móveis só aceitam notificação via service worker */
        }
      }
    }
    void consultar();
    const t = window.setInterval(consultar, POLL_MS);
    return () => {
      vivo = false;
      window.clearInterval(t);
      document.title = baseTitle.current;
    };
  }, [navigate]);

  if (!toast) return null;
  return (
    <button
      type="button"
      className="inbox-toast"
      onClick={() => {
        navigate("/inbox", { state: { conversaId: toast.id } });
        setToast(null);
      }}
    >
      <strong>💬 Nova mensagem · {toast.nome}</strong>
      <span>{toast.preview ?? ""}</span>
    </button>
  );
}
