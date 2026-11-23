import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { api, ApiError } from "../api/client";

type Provedor = "anthropic" | "openai";

interface InfoProvedor {
  nome: Provedor;
  rotulo: string;
  chaveConfigurada: boolean;
  sugeridos: string[];
}
interface Config {
  provedor: Provedor;
  modelo: string;
  origem: "conta" | "ambiente" | "padrao";
  limiteDiario: number;
  provedores: InfoProvedor[];
}
interface Lista {
  modelos: string[];
  fonte: "api" | "sugeridos";
  erro?: string;
}

const VARIAVEL: Record<Provedor, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const OUTRO = "__outro__";

function mensagemDoErro(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const v = JSON.parse(e.message);
      if (typeof v === "string") return v;
    } catch {
      /* texto simples */
    }
    return e.message;
  }
  return e instanceof Error ? e.message : "Erro inesperado";
}

/**
 * Escolha do provedor (Claude ou GPT) e do modelo do assistente, por conta (só ADMIN). A lista de modelos vem ao vivo da
 * API do provedor, com a chave que está no servidor; as chaves nunca passam por aqui. GET/PUT /api/assistente/config e
 * GET /api/assistente/modelos.
 */
export default function AssistenteConfigCard() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [provedor, setProvedor] = useState<Provedor>("anthropic");
  const [modelo, setModelo] = useState("");
  const [lista, setLista] = useState<Lista | null>(null);
  const [carregandoLista, setCarregandoLista] = useState(false);
  const [digitando, setDigitando] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregarLista = useCallback(async (p: Provedor) => {
    setCarregandoLista(true);
    try {
      setLista(await api<Lista>(`/assistente/modelos?provedor=${p}`));
    } catch (e) {
      setLista({ modelos: [], fonte: "sugeridos", erro: mensagemDoErro(e) });
    } finally {
      setCarregandoLista(false);
    }
  }, []);

  useEffect(() => {
    api<Config>("/assistente/config")
      .then((c) => {
        setCfg(c);
        setProvedor(c.provedor);
        setModelo(c.modelo);
      })
      .catch((e) => setMsg({ tipo: "erro", texto: mensagemDoErro(e) }));
  }, []);

  useEffect(() => {
    if (cfg) carregarLista(provedor);
  }, [cfg, provedor, carregarLista]);

  if (!cfg) return msg ? <div className="card" style={{ marginBottom: 16 }}><p className="error-text">{msg.texto}</p></div> : null;

  const info = (p: Provedor) => cfg.provedores.find((x) => x.nome === p);
  const opcoes = Array.from(new Set([...(lista?.modelos ?? info(provedor)?.sugeridos ?? []), ...(modelo && !digitando ? [modelo] : [])]));
  const valorSelect = digitando ? OUTRO : modelo;
  const mudou = provedor !== cfg.provedor || modelo !== cfg.modelo;

  function trocarProvedor(p: Provedor) {
    setProvedor(p);
    setDigitando(false);
    // ao trocar de provedor, o modelo antigo não serve: volta ao primeiro sugerido do novo
    setModelo(p === cfg!.provedor ? cfg!.modelo : info(p)?.sugeridos[0] ?? "");
    setMsg(null);
  }

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      await api("/assistente/config", { method: "PUT", body: { provedor, modelo: modelo.trim() } });
      setCfg({ ...cfg!, provedor, modelo: modelo.trim(), origem: "conta" });
      setMsg({ tipo: "ok", texto: "Configuração salva. Vale para toda a conta, a partir da próxima pergunta." });
    } catch (e) {
      setMsg({ tipo: "erro", texto: mensagemDoErro(e) });
    } finally {
      setSalvando(false);
    }
  }

  const chaveOk = info(provedor)?.chaveConfigurada;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Bot size={18} /> Assistente de IA
      </h3>
      <p className="pd-card-sub">
        Escolha qual IA responde no Assistente e qual modelo usar. O assistente só consulta dados reais do sistema, não faz projeções e não vê dados pessoais de clientes.
        {cfg.origem !== "conta" && " Hoje vale o padrão do servidor, até você salvar uma escolha."}
      </p>

      <div className="form-row">
        <label>Provedor</label>
        <div className="pd-seg" role="group" aria-label="Provedor de IA" style={{ width: "fit-content" }}>
          {cfg.provedores.map((p) => (
            <button key={p.nome} type="button" className={provedor === p.nome ? "on" : ""} aria-pressed={provedor === p.nome} onClick={() => trocarProvedor(p.nome)}>
              {p.rotulo}
            </button>
          ))}
        </div>
        <span className="pd-hint" style={{ color: chaveOk ? "var(--success)" : "var(--warning)" }}>
          {chaveOk
            ? "Chave configurada no servidor."
            : `Chave ainda não configurada. Peça ao responsável técnico para criar a variável ${VARIAVEL[provedor]} no servidor; sem ela o assistente não responde com este provedor.`}
        </span>
      </div>

      <div className="form-row">
        <label htmlFor="assistente-modelo">Modelo</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            id="assistente-modelo"
            value={valorSelect}
            onChange={(e) => {
              if (e.target.value === OUTRO) {
                setDigitando(true);
                setModelo("");
              } else {
                setDigitando(false);
                setModelo(e.target.value);
              }
            }}
            style={{ minWidth: 260 }}
          >
            {opcoes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={OUTRO}>Outro (digitar o ID do modelo)</option>
          </select>
          <button type="button" className="btn secondary" disabled={carregandoLista} onClick={() => carregarLista(provedor)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <RefreshCw size={14} className={carregandoLista ? "spin" : undefined} /> Atualizar lista
          </button>
        </div>
        {digitando && (
          <input value={modelo} onChange={(e) => setModelo(e.target.value)} placeholder="ID exato do modelo, como aparece na conta do provedor" maxLength={100} style={{ marginTop: 8, maxWidth: 420 }} aria-label="ID do modelo" />
        )}
        <span className="pd-hint">
          {lista?.fonte === "api"
            ? `Lista ao vivo da sua conta (${lista.modelos.length} modelos).`
            : `Sugestões. ${lista?.erro ?? ""} Se o seu modelo não aparece, escolha "Outro" e digite o ID.`}
        </span>
      </div>

      {msg && <p className={msg.tipo === "ok" ? "pd-hint" : "error-text"} style={msg.tipo === "ok" ? { color: "var(--success)" } : undefined}>{msg.texto}</p>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={salvando || !mudou || !modelo.trim()} onClick={salvar}>
          {salvando ? "Salvando..." : "Salvar"}
        </button>
        <span className="pd-hint" style={{ margin: 0 }}>Limite de {cfg.limiteDiario} perguntas por usuário por dia.</span>
      </div>
    </div>
  );
}
