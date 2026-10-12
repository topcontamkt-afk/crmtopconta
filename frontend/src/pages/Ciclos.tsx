import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import UsoPorDiaCiclo from "../components/UsoPorDiaCiclo";

interface CicloRow {
  cidadeKey: string;
  cidade: string;
  diaAbertura: number;
  diaFechamento: number;
  clientes: number;
  diaDoCiclo: number;
  diasDesdeAbertura: number;
  diasParaAbrir: number;
  proximaAbertura: string;
}
interface Pendente {
  cidadeKey: string;
  cidade: string;
  clientes: number;
}
interface Resp {
  hoje: string;
  ciclos: CicloRow[];
  pendentes: Pendente[];
}
interface Linha {
  cidade: string;
  abertura: string;
  fechamento: string;
  clientes: number;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Tabela informada pela TopConta (dia de abertura de cada cidade); o fechamento é o dia anterior. */
function sugestaoAbertura(cidade: string): number | null {
  const n = norm(cidade);
  if (/gloria/.test(n)) return 10;
  const tabela: Record<string, number> = { natal: 6, carmopolis: 7, itaporanga: 10, lagarto: 15, itabaianinha: 15, boquim: 15, luziania: 15 };
  return tabela[n.trim()] ?? null;
}

const fechamentoDe = (abertura: number) => (abertura === 1 ? 31 : abertura - 1);

export default function Ciclos() {
  const { user } = useAuth();
  const admin = user?.role === "ADMIN";
  const [data, setData] = useState<Resp | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [novaCidade, setNovaCidade] = useState("");
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    api<Resp>("/ciclos")
      .then((r) => {
        setData(r);
        setLinhas(r.ciclos.map((c) => ({ cidade: c.cidade, abertura: String(c.diaAbertura), fechamento: String(c.diaFechamento), clientes: c.clientes })));
      })
      .catch((e) => setMsg({ tipo: "erro", texto: e.message }));
  }
  useEffect(load, []);

  const jaTem = (cidade: string) => linhas.some((l) => norm(l.cidade).trim() === norm(cidade).trim());

  function adicionar(cidade: string, clientes: number) {
    if (!cidade.trim() || jaTem(cidade)) return;
    const s = sugestaoAbertura(cidade);
    setLinhas((ls) => [...ls, { cidade: cidade.trim(), abertura: s ? String(s) : "", fechamento: s ? String(fechamentoDe(s)) : "", clientes }]);
  }

  function aplicarSugeridas() {
    if (!data) return;
    for (const p of data.pendentes) if (sugestaoAbertura(p.cidade) !== null) adicionar(p.cidade, p.clientes);
  }

  function setAbertura(i: number, v: string) {
    setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, abertura: v, fechamento: v && Number(v) >= 1 && Number(v) <= 31 ? String(fechamentoDe(Number(v))) : "" } : l)));
  }

  async function salvar() {
    setMsg(null);
    const ruim = linhas.find((l) => !(Number(l.abertura) >= 1 && Number(l.abertura) <= 31));
    if (ruim) return setMsg({ tipo: "erro", texto: `Informe o dia de abertura (1 a 31) de ${ruim.cidade}, ou remova a linha.` });
    setBusy(true);
    try {
      const r = await api<{ clientesAtualizados: number }>("/ciclos", {
        method: "PUT",
        body: {
          ciclos: linhas.map((l) => ({ cidade: l.cidade, diaAbertura: Number(l.abertura), diaFechamento: l.fechamento ? Number(l.fechamento) : null })),
        },
      });
      setMsg({ tipo: "ok", texto: `Ciclos salvos. ${r.clientesAtualizados} cliente(s) tiveram o dia de abertura atualizado.` });
      load();
    } catch (e: any) {
      setMsg({ tipo: "erro", texto: e.message });
    } finally {
      setBusy(false);
    }
  }

  const sugeriveis = data?.pendentes.filter((p) => sugestaoAbertura(p.cidade) !== null) ?? [];

  return (
    <div>
      <h2>Ciclos das cidades</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 760 }}>
        No dia de <strong>abertura</strong> do ciclo o limite renova (a fatura é descontada em folha no fechamento, o dia anterior). Com isso o sistema sabe quando
        cada cidade acabou de ter o limite renovado e pode montar públicos como “ciclo abriu há 0 a 3 dias” em Segmentos e campanhas.
        {data && <> Hoje: <strong>{data.hoje}</strong>.</>}
      </p>

      {msg && <p className={msg.tipo === "erro" ? "error-text" : ""} style={{ fontSize: 13 }}>{msg.texto}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr><th>Cidade</th><th>Abertura (dia)</th><th>Fechamento (dia)</th><th>Clientes</th><th>Hoje</th><th>Próxima abertura</th><th></th></tr>
          </thead>
          <tbody>
            {linhas.map((l, i) => {
              const salvo = data?.ciclos.find((c) => norm(c.cidade) === norm(l.cidade));
              return (
                <tr key={l.cidade}>
                  <td>{l.cidade}</td>
                  <td>
                    <input type="number" min={1} max={31} style={{ width: 70 }} disabled={!admin} value={l.abertura} onChange={(e) => setAbertura(i, e.target.value)} />
                  </td>
                  <td>
                    <input
                      type="number" min={1} max={31} style={{ width: 70 }} disabled={!admin} value={l.fechamento}
                      onChange={(e) => setLinhas((ls) => ls.map((x, j) => (j === i ? { ...x, fechamento: e.target.value } : x)))}
                    />
                  </td>
                  <td>{l.clientes}</td>
                  <td>{salvo ? (salvo.diasDesdeAbertura === 0 ? <strong>Abriu hoje</strong> : `Dia ${salvo.diaDoCiclo} do ciclo`) : "—"}</td>
                  <td>{salvo ? `${salvo.proximaAbertura} (em ${salvo.diasParaAbrir} dia${salvo.diasParaAbrir === 1 ? "" : "s"})` : "—"}</td>
                  <td>{admin && <button className="btn secondary" onClick={() => setLinhas((ls) => ls.filter((_, j) => j !== i))}>Remover</button>}</td>
                </tr>
              );
            })}
            {linhas.length === 0 && <tr><td colSpan={7} style={{ color: "var(--text-muted)" }}>Nenhum ciclo cadastrado ainda.</td></tr>}
          </tbody>
        </table>

        {admin && (
          <div style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy} onClick={salvar}>{busy ? "Salvando..." : "Salvar ciclos"}</button>
          </div>
        )}
      </div>

      {admin && data && (
        <div className="card">
          <h3>Cidades da base sem ciclo</h3>
          {sugeriveis.length > 0 && (
            <p style={{ fontSize: 13 }}>
              Reconheci {sugeriveis.length} cidade(s) da tabela da TopConta.{" "}
              <button className="btn secondary" onClick={aplicarSugeridas}>Preencher com a tabela</button>
            </p>
          )}
          {data.pendentes.filter((p) => !jaTem(p.cidade)).length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Todas as cidades da base já têm ciclo.</p>
          ) : (
            <table>
              <thead><tr><th>Cidade</th><th>Clientes</th><th></th></tr></thead>
              <tbody>
                {data.pendentes.filter((p) => !jaTem(p.cidade)).map((p) => (
                  <tr key={p.cidadeKey}>
                    <td>{p.cidade}</td>
                    <td>{p.clientes}</td>
                    <td><button className="btn secondary" onClick={() => adicionar(p.cidade, p.clientes)}>Adicionar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="form-row" style={{ marginTop: 12 }}>
            <label>Adicionar outra cidade</label>
            <input value={novaCidade} onChange={(e) => setNovaCidade(e.target.value)} placeholder="Nome como está na base" />{" "}
            <button className="btn secondary" onClick={() => { adicionar(novaCidade, 0); setNovaCidade(""); }}>Adicionar</button>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Depois de adicionar, clique em “Salvar ciclos” na tabela acima.</p>
        </div>
      )}

      <UsoPorDiaCiclo />
    </div>
  );
}
