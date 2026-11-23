jest.mock("../../config/db", () => ({ prisma: { tenant: { findUnique: jest.fn(), update: jest.fn() } } }));
import { prisma } from "../../config/db";
import { configDoAmbiente, configSchema, lerConfig, salvarConfig } from "./config";

const find = prisma.tenant.findUnique as jest.Mock;
const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ASSISTENTE_PROVEDOR;
  delete process.env.ASSISTENTE_MODELO;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => {
  process.env = ENV_ORIGINAL;
});

describe("lerConfig", () => {
  it("a escolha da conta vale sobre o ambiente", async () => {
    process.env.ASSISTENTE_PROVEDOR = "anthropic";
    find.mockResolvedValue({ assistente: { provedor: "openai", modelo: "gpt-4.1-mini" } });
    expect(await lerConfig("t1")).toEqual({ provedor: "openai", modelo: "gpt-4.1-mini", origem: "conta" });
  });

  it("sem escolha da conta: usa o ambiente; sem ambiente, Claude com o modelo inicial", async () => {
    find.mockResolvedValue({ assistente: null });
    expect(await lerConfig("t1")).toEqual({ provedor: "anthropic", modelo: "claude-opus-5-5", origem: "padrao" });
    process.env.ASSISTENTE_PROVEDOR = "openai";
    expect(await lerConfig("t1")).toEqual({ provedor: "openai", modelo: "gpt-4.1", origem: "ambiente" });
    process.env.ASSISTENTE_MODELO = "gpt-4o";
    expect((await lerConfig("t1")).modelo).toBe("gpt-4o");
  });

  it("configuração guardada inválida é ignorada", async () => {
    find.mockResolvedValue({ assistente: { provedor: "google", modelo: "x" } });
    expect((await lerConfig("t1")).origem).toBe("padrao");
  });

  it("coluna ainda não criada (erro do banco) cai no padrão em vez de derrubar o assistente", async () => {
    find.mockRejectedValue(new Error("column does not exist"));
    expect(await lerConfig("t1")).toMatchObject({ provedor: "anthropic", origem: "padrao" });
  });
});

describe("configDoAmbiente", () => {
  it("só o modelo (sem provedor) vale para Claude; provedor inválido é ignorado", () => {
    expect(configDoAmbiente({ ASSISTENTE_MODELO: "claude-sonnet-5-5" } as any)).toEqual({ provedor: "anthropic", modelo: "claude-sonnet-5-5", origem: "ambiente" });
    expect(configDoAmbiente({ ASSISTENTE_PROVEDOR: "xyz" } as any)).toBeNull();
    expect(configDoAmbiente({ ASSISTENTE_PROVEDOR: "OPENAI", ASSISTENTE_MODELO: "modelo inválido" } as any)).toEqual({ provedor: "openai", modelo: "gpt-4.1", origem: "ambiente" });
  });
});

describe("configSchema e salvarConfig", () => {
  it("valida provedor e ID de modelo e recusa campos extras", () => {
    expect(configSchema.safeParse({ provedor: "openai", modelo: "gpt-4.1" }).success).toBe(true);
    expect(configSchema.safeParse({ provedor: "openai", modelo: "gpt 4" }).success).toBe(false);
    expect(configSchema.safeParse({ provedor: "x", modelo: "gpt-4.1" }).success).toBe(false);
    expect(configSchema.safeParse({ provedor: "openai", modelo: "gpt-4.1", chave: "sk" }).success).toBe(false);
  });
  it("grava só provedor e modelo na conta", async () => {
    await salvarConfig("t1", { provedor: "anthropic", modelo: "claude-opus-5-5" });
    expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { assistente: { provedor: "anthropic", modelo: "claude-opus-5-5" } } });
  });
});
