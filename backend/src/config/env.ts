import { z } from "zod";

/**
 * Validação de variáveis de ambiente na inicialização do processo (fail-fast).
 *
 * Este módulo precisa ser importado antes de qualquer outro módulo que leia `process.env`
 * (ver o import logo no topo de app.ts) — assim, tanto o servidor local de longa duração
 * (src/index.ts) quanto a função serverless (api/index.ts, que também importa app.ts) travam
 * imediatamente, com uma mensagem clara listando o que falta, em vez de só falhar (silenciosa
 * ou obscuramente) quando alguma rota que depende da variável ausente for finalmente chamada.
 */

const requiredSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Role privilegiado (RLS bypass) usado só pelos jobs cross-tenant do scheduler — ver
  // config/tenantGuard.ts (withCrossTenantAccess/prismaAdmin) e a migration add_rls_policies.
  DATABASE_URL_ADMIN: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(1),
});

const REQUIRED_KEYS = requiredSchema.keyof().options as ReadonlyArray<keyof typeof requiredSchema.shape>;

const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Configuração inválida: variável(is) de ambiente obrigatória(s) ausente(s): ${missing.join(", ")}. ` +
      "Configure-a(s) (ver backend/.env.example) antes de iniciar a aplicação."
  );
}

const required = requiredSchema.parse(process.env);

/** Variáveis opcionais — algumas funcionalidades (Google Sheets, WhatsApp, SMS, cron protegido)
 * ficam indisponíveis sem elas, mas a aplicação como um todo deve continuar de pé. */
const OPTIONAL_WARN_KEYS = [
  "CRON_SECRET",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
] as const;

for (const key of OPTIONAL_WARN_KEYS) {
  if (!process.env[key]) {
    console.warn(
      `[env] Variável opcional ${key} não configurada — funcionalidades que dependem dela ficarão indisponíveis.`
    );
  }
}

const DEFAULT_ALLOWED_ORIGIN = "http://localhost:5173";

/** CORS allow-list (ver app.ts). Sem ALLOWED_ORIGINS configurada, cai para o dev server local
 * apenas — nunca abre para qualquer origem por padrão. */
function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || raw.trim().length === 0) {
    console.warn(
      `[env] ALLOWED_ORIGINS não configurada — usando padrão de desenvolvimento (${DEFAULT_ALLOWED_ORIGIN}). ` +
        "Configure com a(s) URL(s) do frontend em produção (ver backend/.env.example)."
    );
    return [DEFAULT_ALLOWED_ORIGIN];
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const env = {
  DATABASE_URL: required.DATABASE_URL,
  DATABASE_URL_ADMIN: required.DATABASE_URL_ADMIN,
  JWT_SECRET: required.JWT_SECRET,
  CREDENTIALS_ENCRYPTION_KEY: required.CREDENTIALS_ENCRYPTION_KEY,

  CRON_SECRET: process.env.CRON_SECRET,
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,

  ALLOWED_ORIGINS: parseAllowedOrigins(),
};
