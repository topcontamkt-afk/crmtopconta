import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
  active: boolean;
  createdAt: string;
}

export default function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRow["role"]>("OPERATOR");
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
      await api("/users", { method: "POST", body: { name, email, password, role } });
      setName("");
      setEmail("");
      setPassword("");
      load();
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : "Erro ao criar usuário");
    }
  }

  async function toggleActive(u: UserRow) {
    await api(`/users/${u.id}`, { method: "PATCH", body: { active: !u.active } });
    load();
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
        {status && <p style={{ marginTop: 10, fontSize: 13 }}>{status}</p>}
      </form>

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td><span className={`badge ${u.active ? "ok" : "danger"}`}>{u.active ? "Ativo" : "Inativo"}</span></td>
                <td>
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
