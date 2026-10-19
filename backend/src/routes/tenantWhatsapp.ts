import { Router } from "express";
import { Prisma } from "../generated/prisma/client";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { withCrossTenantAccess } from "../config/tenantGuard";
import { credentialsOf, generateVerifyToken, hint } from "../services/whatsappAccount";
import { publicBackendUrl } from "../config/publicUrl";
import {
  encryptZapiCredentials,
  instanceIdOf,
  zapiAccountKey,
  zapiCredentialsOf,
  zapiDevice,
  zapiQrImage,
  zapiSetWebhooks,
  zapiStatus,
  ZapiError,
} from "../services/zapi";

/**
 * Configurações → WhatsApp: quais conexões existem (Meta oficial e Z-API não oficial) e QUAL ESTÁ ATIVA para
 * enviar (Tenant.whatsappProvider). Receber vale para as duas conectadas. Tudo só para ADMIN: as respostas
 * trazem dicas de segredo e a URL secreta do webhook. Fica em /api/tenant (área livre, como Configurações).
 */
const router = Router();
router.use(requireAuth, requireRole("ADMIN"));

const webhookUrlOf = (secret: string | null) => {
  const base = publicBackendUrl();
  return secret && base ? `${base}/api/integrations/webhooks/zapi/${secret}` : null;
};

const metaAccount = (tenantId: string) => prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "META" }, orderBy: { createdAt: "asc" } });
const zapiAccount = (tenantId: string) => prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "ZAPI" }, orderBy: { createdAt: "asc" } });

async function overview(tenantId: string) {
  const [tenant, meta, zapi] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { whatsappProvider: true } }),
    metaAccount(tenantId),
    zapiAccount(tenantId),
  ]);
  const metaOk = !!meta && meta.active && !!credentialsOf(meta).accessToken && !!meta.credentials;
  const zapiOk = !!zapi && zapi.active && !!zapiCredentialsOf(zapi);
  return {
    ativo: tenant.whatsappProvider as "META" | "ZAPI",
    meta: { configurado: metaOk, numero: meta?.displayPhone ?? null, nome: meta?.displayName ?? null, ultimoTesteOk: meta?.lastCheckOk ?? null },
    zapi: {
      configurado: zapiOk,
      instanceId: zapi && zapi.active ? instanceIdOf(zapi.phoneNumberId) : null,
      tokenDica: zapi?.accessTokenHint ?? null,
      clientTokenDica: zapi?.appSecretHint ?? null,
      numero: zapi?.displayPhone ?? null,
      conectado: zapi?.lastCheckOk ?? null,
      ultimoTeste: zapi?.lastCheckAt?.toISOString() ?? null,
      mensagem: zapi?.lastCheckMessage ?? null,
      webhookUrl: zapiOk ? webhookUrlOf(zapi!.verifyToken) : null,
    },
  };
}

router.get("/", async (req, res) => {
  res.json(await overview(req.user!.tenantId));
});

const activeSchema = z.object({ provider: z.enum(["META", "ZAPI"]) });

/** PUT /ativo — qual conexão o sistema usa para ENVIAR. Só aceita uma que esteja configurada. */
router.put("/ativo", async (req, res) => {
  const parsed = activeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Escolha META ou ZAPI." });
  const { tenantId, id: userId } = req.user!;
  const o = await overview(tenantId);
  const alvo = parsed.data.provider === "META" ? o.meta : o.zapi;
  if (!alvo.configurado) {
    return res.status(409).json({ error: parsed.data.provider === "META" ? "Conecte a Meta (Integrações → WhatsApp) antes de ativá-la." : "Configure a Z-API antes de ativá-la." });
  }
  await prisma.tenant.update({ where: { id: tenantId }, data: { whatsappProvider: parsed.data.provider } });
  await logAudit({ tenantId, userId, action: "SET_WHATSAPP_PROVIDER", target: "Tenant", targetId: tenantId, details: { de: o.ativo, para: parsed.data.provider } });
  res.json(await overview(tenantId));
});

const zapiSchema = z.object({
  instanceId: z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/, "ID da instância: letras e números"),
  token: z.string().trim().min(8).max(200).optional(),
  clientToken: z.string().trim().max(200).optional(), // "" = sem token de segurança da conta
});

/** PUT /zapi — salva a instância (ID, token e token de segurança da conta); segredos ficam cifrados. */
router.put("/zapi", async (req, res) => {
  const parsed = zapiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Dados inválidos" });
  const { tenantId, id: userId } = req.user!;
  const current = await zapiAccount(tenantId);
  const before = zapiCredentialsOf(current);
  const token = parsed.data.token ?? before?.token;
  if (!token) return res.status(400).json({ error: "Informe o token da instância." });
  const clientToken = parsed.data.clientToken !== undefined ? parsed.data.clientToken : before?.clientToken ?? "";
  const key = zapiAccountKey(parsed.data.instanceId);

  const other = await withCrossTenantAccess(() => prisma.whatsAppAccount.findFirst({ where: { phoneNumberId: key } }));
  if (other && other.tenantId !== tenantId) return res.status(409).json({ error: "Esta instância já está em uso em outra conta." });

  const data = {
    phoneNumberId: key,
    active: true,
    credentials: encryptZapiCredentials({ token, clientToken }) as unknown as Prisma.InputJsonValue,
    accessTokenHint: hint(token),
    appSecretHint: clientToken ? hint(clientToken) : null,
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckMessage: null,
  };
  const account = current
    ? await prisma.whatsAppAccount.update({ where: { id: current.id }, data: { ...data, verifyToken: current.verifyToken ?? generateVerifyToken() } })
    : await prisma.whatsAppAccount.create({ data: { tenantId, provider: "ZAPI", ...data, verifyToken: generateVerifyToken() } });
  await logAudit({ tenantId, userId, action: "CONFIGURE_ZAPI", target: "WhatsAppAccount", targetId: account.id, details: { instanceId: parsed.data.instanceId, tokenAlterado: !!parsed.data.token } });
  res.json(await overview(tenantId));
});

async function credsOr409(tenantId: string, res: any) {
  const account = await zapiAccount(tenantId);
  const creds = zapiCredentialsOf(account);
  if (!account || !account.active || !creds) {
    res.status(409).json({ error: "Salve o ID da instância e o token da Z-API antes." });
    return null;
  }
  return { account, creds };
}

const zapiFail = (res: any, e: unknown) => res.status(502).json({ error: e instanceof ZapiError ? e.message : `Falha ao falar com a Z-API: ${(e as Error).message}` });

/** POST /zapi/test — pergunta à Z-API se o número está conectado e guarda o resultado. */
router.post("/zapi/test", async (req, res) => {
  const ctx = await credsOr409(req.user!.tenantId, res);
  if (!ctx) return;
  try {
    const status = await zapiStatus(ctx.creds);
    let phone: string | null = null;
    let name: string | null = null;
    if (status.connected) {
      try {
        ({ phone, name } = await zapiDevice(ctx.creds));
      } catch {
        /* o telefone é só enfeite: não falha o teste */
      }
    }
    const message = status.connected
      ? `Conectado${phone ? ` (${phone})` : ""}${status.smartphoneConnected ? "" : " — mas o celular está sem internet"}`
      : `Não conectado${status.error ? `: ${status.error}` : ""}`;
    await prisma.whatsAppAccount.update({
      where: { id: ctx.account.id },
      data: { lastCheckAt: new Date(), lastCheckOk: status.connected, lastCheckMessage: message, ...(phone ? { displayPhone: phone } : {}), ...(name ? { displayName: name } : {}) },
    });
    res.json({ conectado: status.connected, celularConectado: status.smartphoneConnected, erro: status.error, telefone: phone, mensagem: message });
  } catch (e) {
    await prisma.whatsAppAccount.update({ where: { id: ctx.account.id }, data: { lastCheckAt: new Date(), lastCheckOk: false, lastCheckMessage: (e as Error).message.slice(0, 300) } }).catch(() => undefined);
    zapiFail(res, e);
  }
});

/** GET /zapi/qr — QR code para conectar (vale ~20 s; a tela renova). Se já estiver conectado, avisa. */
router.get("/zapi/qr", async (req, res) => {
  const ctx = await credsOr409(req.user!.tenantId, res);
  if (!ctx) return;
  try {
    const status = await zapiStatus(ctx.creds);
    if (status.connected) return res.json({ conectado: true, qr: null });
    res.json({ conectado: false, qr: await zapiQrImage(ctx.creds) });
  } catch (e) {
    zapiFail(res, e);
  }
});

/** POST /zapi/webhooks — aponta os webhooks da instância para o nosso endereço (receber mensagens e status). */
router.post("/zapi/webhooks", async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const ctx = await credsOr409(tenantId, res);
  if (!ctx) return;
  const url = webhookUrlOf(ctx.account.verifyToken);
  if (!publicBackendUrl()) return res.status(409).json({ error: "Endereço público do sistema não configurado (PUBLIC_BACKEND_URL)." });
  if (!url) return res.status(409).json({ error: "Salve a instância de novo para gerar o endereço do webhook." });
  try {
    await zapiSetWebhooks(ctx.creds, url);
    await logAudit({ tenantId, userId, action: "SET_ZAPI_WEBHOOKS", target: "WhatsAppAccount", targetId: ctx.account.id });
    res.json({ ok: true });
  } catch (e) {
    zapiFail(res, e);
  }
});

/** DELETE /zapi — desconecta: apaga as credenciais e desativa (o histórico de conversas fica). Se era a ativa, volta para a Meta. */
router.delete("/zapi", async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const account = await zapiAccount(tenantId);
  if (!account) return res.status(404).json({ error: "Nenhuma conexão Z-API." });
  await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { active: false, credentials: Prisma.DbNull, accessTokenHint: null, appSecretHint: null, lastCheckOk: null } });
  await prisma.tenant.updateMany({ where: { id: tenantId, whatsappProvider: "ZAPI" }, data: { whatsappProvider: "META" } });
  await logAudit({ tenantId, userId, action: "DISCONNECT_ZAPI", target: "WhatsAppAccount", targetId: account.id });
  res.status(204).send();
});

export default router;
