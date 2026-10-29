import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { AREAS, AREA_LABEL, AREA_PRESETS, type Area } from "../utils/areas";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
  active: boolean;
  createdAt: string;
  /** áreas liberadas; null = todas */
  areas: Area[] | null;
}

/** Escolha das áreas do sistema que a pessoa pode abrir. `null` = todas. */
function AreasPicker({ value, onChange }: { value: Area[] | null; onChange: (v: Area[] | null) => void }) {
  const todas = value === null;
  const toggle = (a: Area) => onChange(value!.includes(a) ? value!.filter((x) => x !== a) : [...value!, a]);
  return (
    <div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <input type="checkbox" checked={todas} onChange={(e) => onChange(e.target.checked ? null : [...AREAS])} />
        Todas as áreas
      </label>
      {!todas && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="seg-hint">Atalhos:</span>
            {AREA_PRESETS.map((p) => (
              <button key={p.id} type="button" className="btn secondary" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => onChange(p.areas)}>{p.nome}</button>
            ))}
            <button type="button" className="btn secondary" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => onChange([])}>Limpar</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 6 }}>
            {AREAS.map((a) => (
              <label key={a} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={value!.includes(a)} onChange={() => toggle(a)} />
                {AREA_LABEL[a]}
              </label>
            ))}
          </div>
          {value!.length === 0 && <p className="error-text" style={{ marginTop: 6 }}>Sem nenhuma área marcada a pessoa só consegue abrir Minha conta e Configurações.</p>}
        </>
      )}
    </div>
  );
}

export default function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRow["role"]>("OPERATOR");
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [editando, setEditando] = useState<{ user: UserRow; areas: Area[] | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ email: string; tempPassword: string } | null>(null);

  function load() {
    api<UserRow[]>("/users").then(setUsers).catch((e) => setStatus(e instanceof ApiError ? e.message : "Erro ao carregar usuários"));
  }
  useEffect(load, []);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      await api("/users", { method: "POST", body: { name, email, password, role, areas: role === "ADMIN" ? null : areas } });
      setName("");
      setEmail("");
      setPassword("");
      setAreas(null);
      load();
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : "Erro ao criar usuário");
    }
  }

  async function toggleActive(u: UserRow) {
    await api(`/users/${u.id}`, { method: "PATCH", body: { active: !u.active } });
    load();
  }

  async function salvarAcessos() {
    if (!editando) return;
    setStatus(null);
    try {
      await api(`/users/${editando.user.id}`, { method: "PATCH", body: { areas: editando.areas } });
      setEditando(null);
      load();
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : "Erro ao salvar os acessos");
    }
  }

  async function resetPassword(u: UserRow) {
    const resp = await api<{ tempPassword: string }>(`/users/${u.id}/reset-password`, { method: "POST" });
    setResetResult({ email: u.email, tempPassword: resp.tempPassword });
  }

  return (
    <div>
      <h2>Usuários</h2>

      {resetResult && (
        <div className="card" style={{ marginBottom: 16, background: "var(--surface-alt)" }}>
          <strong>Senha temporária gerada para {resetResult.email}:</strong>
          <p style={{ fontSize: 18, fontFamily: "monospace" }}>{resetResult.tempPassword}</p>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Repasse essa senha ao usuário por um canal seguro (não fica salva em nenhum lugar —
            se perder, gere outra). No próximo login ele será obrigado a trocá-la.
          </p>
          <button className="btn secondary" onClick={() => setResetResult(null)}>Fechar</button>
        </div>
      )}

      <form className="card" style={{ marginBottom: 16 }} onSubmit={createUser}>
        <h3>Novo usuário</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input placeholder="Senha inicial (mín. 8)" type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value as UserRow["role"])}>
            <option value="ADMIN">Admin</option>
            <option value="OPERATOR">Operador</option>
            <option value="ANALYST">Analista</option>
            <option value="VIEWER">Visualizador</option>
          </select>
          <button className="btn" type="submit">Criar</button>
        </div>
        {role !== "ADMIN" && (
          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>Acessos</strong>
            <span className="seg-hint" style={{ display: "block", margin: "2px 0 8px" }}>Em quais áreas do sistema a pessoa pode entrar. O papel continua definindo o que ela pode fazer dentro delas.</span>
            <AreasPicker value={areas} onChange={setAreas} />
          </div>
        )}
        {status && <p style={{ marginTop: 10, fontSize: 13 }}>{status}</p>}
      </form>

      {editando && (
        <div className="card" style={{ marginBottom: 16, background: "var(--surface-alt)" }}>
          <strong>Acessos de {editando.user.name}</strong>
          <span className="seg-hint" style={{ display: "block", margin: "2px 0 10px" }}>Vale em até alguns segundos, sem precisar sair e entrar de novo.</span>
          <AreasPicker value={editando.areas} onChange={(v) => setEditando({ ...editando, areas: v })} />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={salvarAcessos}>Salvar acessos</button>
            <button className="btn secondary" onClick={() => setEditando(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Acessos</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td style={{ fontSize: 12.5 }}>
                  {u.areas === null ? "Todas as áreas" : u.areas.length === 0 ? <span className="error-text">Nenhuma</span> : u.areas.map((a) => AREA_LABEL[a]).join(", ")}
                </td>
                <td><span className={`badge ${u.active ? "ok" : "danger"}`}>{u.active ? "Ativo" : "Inativo"}</span></td>
                <td>
                  {u.role !== "ADMIN" && <><button className="btn secondary" onClick={() => setEditando({ user: u, areas: u.areas })}>Acessos</button>{" "}</>}
                  <button className="btn secondary" onClick={() => toggleActive(u)}>{u.active ? "Desativar" : "Ativar"}</button>{" "}
                  <button className="btn secondary" onClick={() => resetPassword(u)}>Resetar senha</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
