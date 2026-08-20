import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";

export default function Login() {
  const { user, login, verifyTwoFactor, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Segunda etapa (2FA): quando /auth/login responde requires2FA, guardamos o tempToken e
  // pedimos o código de 6 dígitos do app autenticador antes de emitir o token de sessão real.
  const [pendingTempToken, setPendingTempToken] = useState<string | null>(null);
  const [code, setCode] = useState("");

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = await login(email, password);
      if ("requires2FA" in result) {
        setPendingTempToken(result.tempToken);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao entrar");
    }
  }

  async function handleVerify2fa(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pendingTempToken) return;
    try {
      await verifyTwoFactor(pendingTempToken, code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Código inválido");
    }
  }

  if (pendingTempToken) {
    return (
      <div className="login-screen">
        <form className="login-box card" onSubmit={handleVerify2fa}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Verificação em duas etapas</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
            Digite o código de 6 dígitos do seu app autenticador (Google Authenticator, Authy...).
          </p>
          <div className="form-row">
            <label>Código</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoFocus
              required
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn" type="submit" disabled={loading || code.length !== 6}>
            {loading ? "Verificando..." : "Confirmar"}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              setPendingTempToken(null);
              setCode("");
              setError(null);
            }}
          >
            Voltar
          </button>
        </form>
      </div>
    );
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
