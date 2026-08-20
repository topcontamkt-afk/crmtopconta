const TOKEN_KEY = "crmtopconta_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = getToken();
  const resp = await fetch(`/api${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (resp.status === 204) return undefined as T;

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new ApiError(resp.status, json.error ? JSON.stringify(json.error) : "Erro inesperado");
  }
  return json as T;
}

/**
 * Download autenticado (ex.: exports CSV): endpoints exigem o header Authorization, então um
 * <a href> comum não funciona (o token vive no localStorage, não em cookie). Busca o arquivo com
 * o header correto e simula o download via Blob URL.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const resp = await fetch(`/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}));
    throw new ApiError(resp.status, json.error ? JSON.stringify(json.error) : "Erro ao exportar arquivo");
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
