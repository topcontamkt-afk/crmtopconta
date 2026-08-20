import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function Account() {
  const { user, refreshUser } = useAuth();
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);

  // Troca de senha
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  // Setup de 2FA
  const [qrCodeDataUri, setQrCodeDataUri] = useState<string | null>(null);
  const [manualSecret, setManualSecret] = useState<string | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [twoFaStatus, setTwoFaStatus] = useState<string | null>(null);
  const [disablePassword, setDisablePassword] = useState("");

  useEffect(() => {
    api<{ twoFactorEnabled: boolean }>("/auth/me").then((me) => setTwoFactorEnabled(me.twoFactorEnabled));
  }, []);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordStatus(null);
    try {
      await api("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
      setPasswordStatus("Senha alterada com sucesso.");
      setCurrentPassword("");
      setNewPassword("");
      refreshUser();
    } catch (e) {
      setPasswordStatus(e instanceof ApiError ? e.message : "Erro ao trocar senha");
    }
  }

  async function startTwoFactorSetup() {
    setTwoFaStatus(null);
    const resp = await api<{ qrCodeDataUri: string; secret: string }>("/auth/2fa/setup", { method: "POST" });
    setQrCodeDataUri(resp.qrCodeDataUri);
    setManualSecret(resp.secret);
  }

  async function confirmEnable(e: FormEvent) {
    e.preventDefault();
    setTwoFaStatus(null);
    try {
      await api("/auth/2fa/enable", { method: "POST", body: { code: enableCode } });
      setTwoFactorEnabled(true);
      setQrCodeDataUri(null);
      setManualSecret(null);
      setEnableCode("");
      setTwoFaStatus("2FA ativado com sucesso.");
    } catch (e) {
      setTwoFaStatus(e instanceof ApiError ? e.message : "Código inválido");
    }
  }

  async function disableTwoFactor(e: FormEvent) {
    e.preventDefault();
    setTwoFaStatus(null);
    try {
      await api("/auth/2fa/disable", { method: "POST", body: { password: disablePassword } });
      setTwoFactorEnabled(false);
      setDisablePassword("");
      setTwoFaStatus("2FA desativado.");
    } catch (e) {
      setTwoFaStatus(e instanceof ApiError ? e.message : "Erro ao desativar 2FA");
    }
  }

  return (
    <div>
      <h2>Minha conta</h2>
      <p style={{ color: "var(--text-muted)" }}>{user?.name} · {user?.email}</p>

      <form className="card" style={{ marginBottom: 16, maxWidth: 420 }} onSubmit={changePassword}>
        <h3>Trocar senha</h3>
        <div className="form-row">
          <label>Senha atual</label>
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </div>
        <div className="form-row">
          <label>Nova senha (mín. 8 caracteres)</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
        </div>
        {passwordStatus && <p style={{ fontSize: 13 }}>{passwordStatus}</p>}
        <button className="btn" type="submit">Trocar senha</button>
      </form>

      <div className="card" style={{ maxWidth: 420 }}>
        <h3>Verificação em duas etapas (2FA)</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Adiciona uma segunda etapa no login (código de 6 dígitos gerado por um app tipo Google
          Authenticator ou Authy), além da senha.
        </p>

        {twoFactorEnabled ? (
          <>
            <p><span className="badge ok">Ativado</span></p>
            <form onSubmit={disableTwoFactor}>
              <div className="form-row">
                <label>Digite sua senha para desativar</label>
                <input type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} required />
              </div>
              <button className="btn secondary" type="submit">Desativar 2FA</button>
            </form>
          </>
        ) : qrCodeDataUri ? (
          <form onSubmit={confirmEnable}>
            <p style={{ fontSize: 13 }}>Escaneie o QR code com seu app autenticador:</p>
            <img src={qrCodeDataUri} alt="QR code para configurar 2FA" style={{ width: 180, height: 180 }} />
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Não consegue escanear? Digite manualmente: <code>{manualSecret}</code>
            </p>
            <div className="form-row">
              <label>Código de 6 dígitos gerado pelo app</label>
              <input
                value={enableCode}
                onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                required
              />
            </div>
            <button className="btn" type="submit" disabled={enableCode.length !== 6}>Confirmar e ativar</button>
          </form>
        ) : (
          <button className="btn" onClick={startTwoFactorSetup}>Configurar 2FA</button>
        )}
        {twoFaStatus && <p style={{ fontSize: 13, marginTop: 8 }}>{twoFaStatus}</p>}
      </div>
    </div>
  );
}
