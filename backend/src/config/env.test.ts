describe("config/env", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("lança erro ao importar com variáveis obrigatórias ausentes", () => {
    delete process.env.JWT_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;

    expect(() => require("./env")).toThrow(/JWT_SECRET/);
  });

  it("lista todas as variáveis obrigatórias ausentes na mensagem de erro", () => {
    delete process.env.JWT_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;

    expect(() => require("./env")).toThrow(/JWT_SECRET.*CREDENTIALS_ENCRYPTION_KEY/s);
  });

  it("não lança erro quando todas as variáveis obrigatórias estão presentes", () => {
    process.env.JWT_SECRET = "segredo-de-teste";
    process.env.CREDENTIALS_ENCRYPTION_KEY = "chave-de-teste";

    let mod: typeof import("./env") | undefined;
    expect(() => {
      mod = require("./env");
    }).not.toThrow();
    expect(mod?.env.JWT_SECRET).toBe("segredo-de-teste");
    expect(mod?.env.CREDENTIALS_ENCRYPTION_KEY).toBe("chave-de-teste");
  });
});
