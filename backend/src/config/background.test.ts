import { background, configureBackground } from "./background";

describe("background", () => {
  afterEach(() => configureBackground(() => undefined));

  it("entrega a promessa ao waitUntil registrado", async () => {
    const recebidas: Promise<unknown>[] = [];
    configureBackground((p) => recebidas.push(p));
    background("teste", Promise.resolve("ok"));
    expect(recebidas).toHaveLength(1);
    await expect(recebidas[0]).resolves.toBe("ok");
  });

  it("erro vai para o log e não rejeita a promessa entregue", async () => {
    const erro = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const recebidas: Promise<unknown>[] = [];
    configureBackground((p) => recebidas.push(p));
    background("auditoria", Promise.reject(new Error("db fora")));
    await expect(recebidas[0]).resolves.toBeUndefined();
    expect(erro).toHaveBeenCalledWith("[background] auditoria:", expect.any(Error));
    erro.mockRestore();
  });
});
