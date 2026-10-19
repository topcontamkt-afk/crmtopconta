/**
 * Acesso por área do sistema. As áreas são as mesmas do menu lateral. O PAPEL (ADMIN/OPERATOR/ANALYST/
 * VIEWER) continua dizendo o que a pessoa pode fazer; a ÁREA diz onde ela pode entrar. Tudo aqui é puro
 * (sem banco/Express): `areaForRequest` mapeia "método + caminho da API" para as áreas que dão acesso
 * (qualquer uma serve) e é conferido no servidor por middleware/areaAccess.ts. Esconder o menu não protege
 * nada sozinho — a conferência de verdade é na API.
 */
export const AREAS = ["dashboard", "clients", "segments", "commerce", "ciclos", "inbox", "campaigns", "templates", "automations", "imports", "integrations", "audit"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABEL: Record<Area, string> = {
  dashboard: "Dashboard",
  clients: "Base de clientes",
  segments: "Segmentos",
  commerce: "Comércio credenciado",
  ciclos: "Ciclos das cidades",
  inbox: "Inbox WhatsApp",
  campaigns: "Campanhas",
  templates: "Templates",
  automations: "Automações",
  imports: "Importações",
  integrations: "Integrações",
  audit: "Auditoria",
};

/** Atalhos de perfil para a tela de Acessos. */
export const AREA_PRESETS: { id: string; nome: string; areas: Area[] }[] = [
  { id: "marketing", nome: "Marketing", areas: ["dashboard", "clients", "segments", "campaigns", "templates"] },
  { id: "atendimento", nome: "Atendimento", areas: ["inbox"] },
  { id: "analista", nome: "Analista", areas: ["dashboard", "commerce", "ciclos"] },
];

export const isArea = (v: unknown): v is Area => typeof v === "string" && (AREAS as readonly string[]).includes(v);

/** Tira o que não é área válida e repetidos. */
export function cleanAreas(v: unknown): Area[] {
  return Array.isArray(v) ? [...new Set(v.filter(isArea))] : [];
}

type Rule = { prefix: string; methods?: "GET"; areas: readonly Area[] };

/**
 * Regras na ordem: a primeira que casa vale (as mais específicas vêm antes). `GET` = só leitura; as demais
 * valem para qualquer método. Cada tela só chama as APIs listadas aqui — quem vê "Campanhas" também precisa
 * LER templates, segmentos e filtros de comércio para montar a campanha, mas não ganha as telas deles.
 */
const RULES: Rule[] = [
  // Públicos / de uso geral: sem área (o papel e o login já protegem)
  { prefix: "/auth", areas: [] },
  { prefix: "/notifications", areas: [] },
  { prefix: "/tenant", areas: [] },
  { prefix: "/users", areas: [] }, // só ADMIN (requireRole na rota)
  { prefix: "/cron", areas: [] },
  { prefix: "/integrations/webhooks", areas: [] }, // webhooks da Meta/Twilio: públicos, validados por assinatura
  { prefix: "/integrations/channels", areas: [] }, // tela Configurações (todos); escrita é ADMIN na rota
  { prefix: "/voice/twilio-status", areas: [] },
  { prefix: "/voice/inbound", areas: [] },

  { prefix: "/dashboard", areas: ["dashboard"] },
  { prefix: "/clients/purge", areas: ["imports"] },
  { prefix: "/clients", areas: ["clients"] },
  { prefix: "/titular", areas: ["clients"] }, // LGPD 03-05: pedidos de titular ficam com a Base de clientes
  { prefix: "/segments/presets", areas: ["segments", "dashboard"] },
  { prefix: "/segments", methods: "GET", areas: ["segments", "campaigns"] },
  { prefix: "/segments", areas: ["segments"] },
  { prefix: "/purchases/import", areas: ["imports"] },
  { prefix: "/purchases", methods: "GET", areas: ["commerce", "segments", "campaigns"] },
  { prefix: "/purchases", areas: ["commerce"] },
  { prefix: "/ciclos/proximos", areas: ["ciclos", "dashboard"] },
  { prefix: "/ciclos/audiencia", areas: ["ciclos", "dashboard"] },
  { prefix: "/ciclos", methods: "GET", areas: ["ciclos", "automations"] },
  { prefix: "/ciclos", areas: ["ciclos"] },
  { prefix: "/inbox", areas: ["inbox"] },
  { prefix: "/campaigns", areas: ["campaigns"] },
  { prefix: "/templates/sync", areas: ["templates", "campaigns"] },
  { prefix: "/templates", methods: "GET", areas: ["templates", "campaigns", "automations"] },
  { prefix: "/templates", areas: ["templates", "campaigns"] }, // PATCH do mapa de variáveis acontece no assistente de campanha
  { prefix: "/automations", areas: ["automations"] },
  { prefix: "/imports", areas: ["imports"] },
  { prefix: "/integrations", areas: ["integrations"] },
  { prefix: "/voice", areas: ["integrations"] },
  { prefix: "/audit-logs", areas: ["audit"] },
];

/** Prefixos da API que não precisam de área (para o teste garantir que nenhuma rota nova ficou sem regra). */
export const OPEN_PREFIXES = RULES.filter((r) => r.areas.length === 0).map((r) => r.prefix);
export const GUARDED_PREFIXES = RULES.filter((r) => r.areas.length > 0).map((r) => r.prefix);

/**
 * Normaliza o caminho do jeito que o Express o casa com as rotas: sem diferenciar maiúsculas (o roteamento
 * do Express é case-insensitive por padrão), com %XX decodificado e barras repetidas colapsadas. Sem isso,
 * "/CLIENTS/export.csv" chegava na rota de clientes mas escapava da regra "/clients" (LGPD 05-07).
 */
export function normalizeApiPath(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(p);
  } catch {
    // %XX malformado: segue com o texto cru (o Express também não casaria rota com ele)
  }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  return ("/" + p.replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
}

/** Áreas que dão acesso a este pedido (qualquer uma serve), ou null se não há restrição por área. `path` é relativo a /api. */
export function areaForRequest(method: string, path: string): readonly Area[] | null {
  const p = normalizeApiPath(path);
  const m = method.toUpperCase();
  for (const r of RULES) {
    if (p !== r.prefix && !p.startsWith(r.prefix + "/")) continue;
    if (r.methods && r.methods !== (m === "HEAD" ? "GET" : m)) continue;
    return r.areas.length === 0 ? null : r.areas;
  }
  return null;
}

export interface AccessProfile {
  role: string;
  areasRestritas: boolean;
  /** `User.areas` (Json no D1): lista de áreas; `cleanAreas` descarta o que não for área válida. */
  areas: unknown;
}

/** Áreas liberadas para a pessoa: null = todas (Admin, ou sem restrição). */
export function allowedAreas(u: AccessProfile): Area[] | null {
  if (u.role === "ADMIN" || !u.areasRestritas) return null;
  return cleanAreas(u.areas);
}

export function canAccess(u: AccessProfile, required: readonly Area[] | null): boolean {
  if (!required) return true;
  const allowed = allowedAreas(u);
  return allowed === null || required.some((a) => allowed.includes(a));
}
