/**
 * Acesso por área do sistema — espelho de backend/src/services/areas.ts (pacotes independentes). A
 * conferência de verdade é no servidor; aqui só decide o que aparece no menu e para onde redirecionar.
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

export const AREA_PATH: Record<Area, string> = {
  dashboard: "/",
  clients: "/clients",
  segments: "/segments",
  commerce: "/commerce",
  ciclos: "/ciclos",
  inbox: "/inbox",
  campaigns: "/campaigns",
  templates: "/templates",
  automations: "/automations",
  imports: "/imports",
  integrations: "/integrations",
  audit: "/audit",
};

export const AREA_PRESETS: { id: string; nome: string; areas: Area[] }[] = [
  { id: "marketing", nome: "Marketing", areas: ["dashboard", "clients", "segments", "campaigns", "templates"] },
  { id: "atendimento", nome: "Atendimento", areas: ["inbox"] },
  { id: "analista", nome: "Analista", areas: ["dashboard", "commerce", "ciclos"] },
];

/** `areas` null/ausente = todas as áreas (Admin, ou sem restrição). */
export const podeVer = (areas: Area[] | null | undefined, area: Area) => !areas || areas.includes(area);

/** Área de uma tela, pelo endereço; null para telas livres (Configurações, Minha conta, Usuários). */
export function areaDoCaminho(pathname: string): Area | null {
  if (pathname === "/" || pathname.startsWith("/perfis-renda")) return "dashboard";
  for (const a of AREAS) {
    const p = AREA_PATH[a];
    if (p !== "/" && (pathname === p || pathname.startsWith(p + "/"))) return a;
  }
  return null;
}

/** Primeira tela liberada, na ordem do menu; null se não há nenhuma. */
export function primeiraTelaLiberada(areas: Area[] | null | undefined): string | null {
  const a = AREAS.find((x) => podeVer(areas, x));
  return a ? AREA_PATH[a] : null;
}
