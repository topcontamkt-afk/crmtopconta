import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, getToken, setToken } from "../api/client";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
  tenantId: string;
  mustChangePassword?: boolean;
}

type LoginResult = { ok: true } | { requires2FA: true; tempToken: string };

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyTwoFactor: (tempToken: string, code: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const USER_KEY = "crmtopconta_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!getToken()) setUser(null);
  }, []);

  function applySession(token: string, sessionUser: AuthUser) {
    setToken(token);
    localStorage.setItem(USER_KEY, JSON.stringify(sessionUser));
    setUser(sessionUser);
  }

  async function login(email: string, password: string): Promise<LoginResult> {
    setLoading(true);
    try {
      const resp = await api<{ token: string; user: AuthUser } | { requires2FA: true; tempToken: string }>(
        "/auth/login",
        { method: "POST", body: { email, password } }
      );
      if ("requires2FA" in resp) {
        return resp;
      }
      applySession(resp.token, resp.user);
      return { ok: true };
    } finally {
      setLoading(false);
    }
  }

  async function verifyTwoFactor(tempToken: string, code: string) {
    setLoading(true);
    try {
      const resp = await api<{ token: string; user: AuthUser }>("/auth/2fa/verify", {
        method: "POST",
        body: { tempToken, code },
      });
      applySession(resp.token, resp.user);
    } finally {
      setLoading(false);
    }
  }

  async function refreshUser() {
    if (!getToken()) return;
    const me = await api<AuthUser>("/auth/me");
    localStorage.setItem(USER_KEY, JSON.stringify(me));
    setUser(me);
  }

  function logout() {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, verifyTwoFactor, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}
