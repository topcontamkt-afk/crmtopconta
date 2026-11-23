import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Copy, Download, Printer, Send, ShieldCheck } from "lucide-react";
import { api, ApiError } from "../api/client";

interface Chamada {
  nome: string;
  entrada: unknown;
  ok: boolean;
}
interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  ferramentas?: Chamada[];
  avisos?: string[];
  erro?: boolean;
}
interface Status {
  configurado: boolean;
  modelo: string;
  limiteDiario: number;
  usadasHoje: number;
}
interface Resposta {
  resposta: string;
  ferramentas: Chamada[];
  avisos: string[];
  restantesHoje: number;
}

const NOME_FERRAMENTA: Record<string, string> = {
  resumo_base: "Visão geral da base",
  contar_clientes: "Contagem de clientes",
  oportunidades: "Oportunidades",
  comparar_periodos: "Comparação de períodos",
  desempenho_cidades: "Desempenho por cidade",
  desempenho_convenios: "Desempenho por convênio",
  financeiro_mes: "Financeiro do mês",
  uso_por_hora: "Uso por hora do dia",
  fontes_de_dados: "Frescor das fontes de dados",
  campanhas_recentes: "Campanhas recentes",
};

const SUGESTOES = [
  "Faça um relatório executivo do mês com os dados que temos.",
  "Qual cidade tem a maior taxa de uso e qual teve a maior queda?",
  "Quantos clientes inativos temos em cada cidade?",
  "O que melhorou e o que caiu nos últimos 30 dias?",
  "Em que horários os clientes mais fazem saque?",
  "Os dados estão atualizados? Quando foi a última importação?",
];

const LIMITE_HISTORICO = 19; // o servidor aceita até 20 mensagens, contando a nova

/** O ApiError traz o texto do servidor em JSON; devolve a frase sem as aspas. */
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

function baixar(nome: string, conteudo: string) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Assistente de dados (POST /api/assistente): responde só com dados reais do sistema, sem projeções nem estimativas,
 * e mostra quais consultas fez em cada resposta. Relatórios saem em markdown (copiar, baixar .md ou imprimir/PDF).
 */
export default function Assistente() {
  const [status, setStatus] = useState<Status | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [impressao, setImpressao] = useState<number | null>(null);
  const fim = useRef<HTMLDivElement>(null);
  const proximoId = useRef(1);

  useEffect(() => {
    api<Status>("/assistente/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, enviando]);

  useEffect(() => {
    const depois = () => setImpressao(null);
    window.addEventListener("afterprint", depois);
    return () => window.removeEventListener("afterprint", depois);
  }, []);

  const perguntar = useCallback(
    async (pergunta: string) => {
      const p = pergunta.trim();
      if (!p || enviando) return;
      const nova: Msg = { id: proximoId.current++, role: "user", content: p };
      const historico = [...msgs.filter((m) => !m.erro), nova].map((m) => ({ role: m.role, content: m.content }));
      // o servidor exige que a conversa comece com uma pergunta
      let janela = historico.slice(-(LIMITE_HISTORICO + 1));
      while (janela.length > 1 && janela[0].role !== "user") janela = janela.slice(1);
      setMsgs((m) => [...m, nova]);
      setTexto("");
      setEnviando(true);
      try {
        const r = await api<Resposta>("/assistente", { method: "POST", body: { mensagens: janela } });
        setMsgs((m) => [...m, { id: proximoId.current++, role: "assistant", content: r.resposta, ferramentas: r.ferramentas, avisos: r.avisos }]);
        setStatus((s) => (s ? { ...s, usadasHoje: s.limiteDiario - r.restantesHoje } : s));
      } catch (e) {
        setMsgs((m) => [...m, { id: proximoId.current++, role: "assistant", content: mensagemDoErro(e), erro: true }]);
      } finally {
        setEnviando(false);
      }
    },
    [msgs, enviando]
  );

  function imprimir(id: number) {
    setImpressao(id);
    setTimeout(() => window.print(), 50);
  }

  return (
    <div className="pd as-pagina">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <Bot size={22} /> Assistente de dados
          </h2>
          <p className="pd-sub">Pergunte sobre clientes, uso, cidades, convênios, financeiro e campanhas, ou peça um relatório.</p>
        </div>
        {status?.configurado && (
          <span className="pd-hint" style={{ margin: 0 }}>
            {status.usadasHoje} de {status.limiteDiario} perguntas hoje
          </span>
        )}
      </div>

      <div className="card pd-card as-aviso">
        <ShieldCheck size={18} />
        <span>
          <strong>Só dados reais do sistema.</strong> O assistente não faz projeções, previsões nem estimativas, e não vê nome, telefone ou CPF de clientes. Ele apenas consulta: não envia mensagens nem altera nada.
        </span>
      </div>

      {status && !status.configurado && (
        <div className="card pd-card" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)" }}>
          <strong style={{ color: "var(--warning)" }}>Assistente não configurado neste ambiente.</strong>
          <p className="pd-card-sub" style={{ margin: "6px 0 0" }}>
            Falta a chave de IA (variável <code>ANTHROPIC_API_KEY</code> do servidor). Peça a um administrador para configurá-la.
          </p>
        </div>
      )}

      <div className="as-conversa" aria-live="polite">
        {msgs.length === 0 && (
          <div className="card pd-card">
            <h3>Comece por uma pergunta</h3>
            <div className="as-sugestoes">
              {SUGESTOES.map((s) => (
                <button key={s} type="button" className="pd-chip" disabled={enviando || status?.configurado === false} onClick={() => perguntar(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="as-linha as-usuario">
              <div className="as-balao">{m.content}</div>
            </div>
          ) : (
            <div key={m.id} className="as-linha">
              <div className={`card as-resposta${m.erro ? " as-erro" : ""}${impressao === m.id ? " as-alvo-impressao" : ""}`}>
                {m.erro ? (
                  <p style={{ margin: 0 }}>{m.content}</p>
                ) : (
                  <div className="as-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                )}
                {m.avisos && m.avisos.length > 0 && <p className="pd-note" style={{ color: "var(--warning)" }}>{m.avisos.join(" ")}</p>}
                {!m.erro && (
                  <div className="as-acoes">
                    <button type="button" className="btn secondary" onClick={() => navigator.clipboard?.writeText(m.content)}>
                      <Copy size={14} /> Copiar
                    </button>
                    <button type="button" className="btn secondary" onClick={() => baixar(`relatorio-${m.id}.md`, m.content)}>
                      <Download size={14} /> Baixar .md
                    </button>
                    <button type="button" className="btn secondary" onClick={() => imprimir(m.id)}>
                      <Printer size={14} /> Imprimir / PDF
                    </button>
                  </div>
                )}
                {m.ferramentas && m.ferramentas.length > 0 && (
                  <details className="as-consultas">
                    <summary>Dados consultados ({m.ferramentas.length})</summary>
                    <ul>
                      {m.ferramentas.map((c, i) => (
                        <li key={i}>
                          {NOME_FERRAMENTA[c.nome] ?? c.nome}
                          {c.entrada && Object.keys(c.entrada as object).length > 0 ? <code> {JSON.stringify(c.entrada)}</code> : null}
                          {!c.ok && <span style={{ color: "var(--danger)" }}> (falhou)</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          )
        )}

        {enviando && (
          <div className="as-linha">
            <div className="card as-resposta pd-skel" style={{ height: 56 }} aria-label="Consultando os dados" />
          </div>
        )}
        <div ref={fim} />
      </div>

      <form
        className="card as-entrada"
        onSubmit={(e) => {
          e.preventDefault();
          perguntar(texto);
        }}
      >
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              perguntar(texto);
            }
          }}
          placeholder="Pergunte sobre os dados do sistema (Enter envia, Shift+Enter quebra a linha)"
          rows={2}
          maxLength={4000}
          disabled={enviando || status?.configurado === false}
          aria-label="Pergunta"
        />
        <button className="btn" type="submit" disabled={enviando || !texto.trim() || status?.configurado === false}>
          <Send size={14} /> {enviando ? "Consultando..." : "Perguntar"}
        </button>
      </form>
    </div>
  );
}
