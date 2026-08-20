import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, getToken, setToken } from "../api/client";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
  tenantId: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
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

  async function login(email: string, password: string) {
    setLoading(true);
    try {
      const resp = await api<{ token: string; user: AuthUser }>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setToken(resp.token);
      localStorage.setItem(USER_KEY, JSON.stringify(resp.user));
      setUser(resp.user);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}
