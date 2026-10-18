import fs from "fs";
import path from "path";
import { AREAS, AREA_PRESETS, GUARDED_PREFIXES, OPEN_PREFIXES, allowedAreas, areaForRequest, canAccess, cleanAreas } from "./areas";

const pessoa = (areas: string[], role = "OPERATOR") => ({ role, areasRestritas: true, areas });

describe("areaForRequest", () => {
  it("mapeia cada tela para a sua área", () => {
    expect(areaForRequest("GET", "/clients")).toEqual(["clients"]);
    expect(areaForRequest("GET", "/clients/abc-123")).toEqual(["clients"]);
    expect(areaForRequest("GET", "/dashboard/overview")).toEqual(["dashboard"]);
    expect(areaForRequest("GET", "/inbox/conversations")).toEqual(["inbox"]);
    expect(areaForRequest("GET", "/inbox/resumo")).toEqual(["inbox"]);
    expect(areaForRequest("GET", "/audit-logs")).toEqual(["audit"]);
    expect(areaForRequest("PUT", "/ciclos")).toEqual(["ciclos"]);
    expect(areaForRequest("POST", "/automations/1/run")).toEqual(["automations"]);
  });

  it("casa o caminho como o Express: sem diferenciar maiúsculas, com %XX decodificado e barras repetidas (LGPD 05-07)", () => {
    expect(areaForRequest("GET", "/CLIENTS/export.csv")).toEqual(["clients"]);
    expect(areaForRequest("GET", "/Clients/Export.csv")).toEqual(["clients"]);
    expect(areaForRequest("GET", "/%63lients/export.csv")).toEqual(["clients"]);
    expect(areaForRequest("GET", "//clients//export.csv")).toEqual(["clients"]);
    expect(areaForRequest("GET", "/AUDIT-LOGS")).toEqual(["audit"]);
    expect(areaForRequest("POST", "/Clients/PURGE")).toEqual(["imports"]);
    expect(areaForRequest("GET", "/%E0%A4%A")).toBeNull(); // %XX malformado não derruba
  });

  it("não confunde prefixos parecidos", () => {
    expect(areaForRequest("GET", "/clientsx")).toBeNull();
    expect(areaForRequest("GET", "/inboxes")).toBeNull();
  });

  it("deixa livres login, notificações, configurações, cron e webhooks públicos", () => {
    for (const p of ["/auth/login", "/auth/me", "/notifications", "/tenant/settings", "/cron/snapshot", "/integrations/webhooks/whatsapp", "/voice/twilio-status", "/voice/inbound", "/integrations/channels", "/users"]) {
      expect(areaForRequest("GET", p)).toBeNull();
    }
    expect(areaForRequest("POST", "/integrations/webhooks/whatsapp")).toBeNull();
  });

  it("importação de compras e limpeza de clientes são da área Importações", () => {
    expect(areaForRequest("POST", "/purchases/import")).toEqual(["imports"]);
    expect(areaForRequest("POST", "/clients/purge")).toEqual(["imports"]);
    expect(areaForRequest("POST", "/imports/csv")).toEqual(["imports"]);
  });

  it("campanhas LEEM templates, segmentos e filtros de comércio, mas não os alteram", () => {
    expect(areaForRequest("GET", "/templates")).toContain("campaigns");
    expect(areaForRequest("GET", "/segments")).toContain("campaigns");
    expect(areaForRequest("GET", "/segments/preview")).toContain("campaigns");
    expect(areaForRequest("GET", "/purchases/categories")).toContain("campaigns");
    expect(areaForRequest("POST", "/segments")).toEqual(["segments"]);
    expect(areaForRequest("DELETE", "/segments/1")).toEqual(["segments"]);
    expect(areaForRequest("POST", "/templates/sync")).toContain("campaigns");
    expect(areaForRequest("PATCH", "/templates/1")).toContain("campaigns"); // mapa de variáveis no assistente
    expect(areaForRequest("PATCH", "/purchases/merchants/1")).toEqual(["commerce"]);
  });

  it("cartões do dashboard usam APIs de outras áreas", () => {
    expect(areaForRequest("GET", "/ciclos/proximos")).toContain("dashboard");
    expect(areaForRequest("GET", "/ciclos/audiencia")).toContain("dashboard");
    expect(areaForRequest("POST", "/segments/presets/perfis-renda")).toContain("dashboard");
    expect(areaForRequest("GET", "/ciclos")).toContain("automations");
  });

  it("voz e Integrações são a mesma área", () => {
    expect(areaForRequest("POST", "/voice/test-call")).toEqual(["integrations"]);
    expect(areaForRequest("GET", "/integrations/whatsapp")).toEqual(["integrations"]);
  });

  it("aceita caminho sem barra inicial e com barra final", () => {
    expect(areaForRequest("GET", "clients/")).toEqual(["clients"]);
  });
});

describe("allowedAreas / canAccess", () => {
  it("Admin vê tudo, mesmo se tiver lista restrita", () => {
    expect(allowedAreas(pessoa(["inbox"], "ADMIN"))).toBeNull();
    expect(canAccess(pessoa(["inbox"], "ADMIN"), ["audit"])).toBe(true);
  });
  it("sem restrição (padrão e quem já existia) vê tudo", () => {
    expect(allowedAreas({ role: "ANALYST", areasRestritas: false, areas: [] })).toBeNull();
    expect(canAccess({ role: "ANALYST", areasRestritas: false, areas: [] }, ["audit"])).toBe(true);
  });
  it("restrito só entra nas áreas da lista (qualquer uma das exigidas serve)", () => {
    const u = pessoa(["campaigns"]);
    expect(canAccess(u, ["campaigns"])).toBe(true);
    expect(canAccess(u, ["templates", "campaigns"])).toBe(true);
    expect(canAccess(u, ["templates"])).toBe(false);
    expect(canAccess(u, ["audit"])).toBe(false);
  });
  it("lista vazia restrita = nenhuma área", () => {
    expect(canAccess(pessoa([]), ["dashboard"])).toBe(false);
  });
  it("sem área exigida, sempre passa", () => {
    expect(canAccess(pessoa([]), null)).toBe(true);
  });
});

describe("cleanAreas", () => {
  it("tira lixo e repetidos", () => {
    expect(cleanAreas(["inbox", "inbox", "x", 3, "audit"])).toEqual(["inbox", "audit"]);
    expect(cleanAreas("inbox")).toEqual([]);
    expect(cleanAreas(null)).toEqual([]);
  });
});

describe("presets", () => {
  it("só usam áreas que existem", () => {
    for (const p of AREA_PRESETS) expect(p.areas.every((a) => (AREAS as readonly string[]).includes(a))).toBe(true);
  });
});

describe("cobertura das rotas montadas em app.ts", () => {
  it("toda rota /api tem regra de área ou está explicitamente liberada", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "app.ts"), "utf8");
    const mounts = [...src.matchAll(/app\.use\("\/api\/([a-z-]+)"/g)].map((m) => "/" + m[1]);
    expect(mounts.length).toBeGreaterThan(10);
    const conhecidos = new Set([...OPEN_PREFIXES, ...GUARDED_PREFIXES].map((p) => "/" + p.split("/")[1]));
    for (const m of mounts) expect(conhecidos.has(m)).toBe(true);
  });
});
