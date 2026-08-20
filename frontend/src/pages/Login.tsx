import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";

export default function Login() {
  const { user, login, loading } = useAuth();
  const [email, setEmail] = useState("admin@topconta.demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao entrar");
    }
  }

  return (
    <div className="login-screen">
      <form className="login-box card" onSubmit={handleSubmit}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>CRM TopConta</h1>
        <div className="form-row">
          <label>E-mail</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </div>
        <div className="form-row">
          <label>Senha</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
