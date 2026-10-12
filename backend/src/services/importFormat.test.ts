import { detectFormat, formatMismatch } from "./importFormat";

const COMPRAS = ["IdTransacaoCartao", "DtConfirmada", "CpfCnpjCliente", "Descrição", "NomeFantasia", "ValorPrincipal", "ValorParcela", "Juros", "razaoSocial"];
const CARTOES = ["CpfCnpjCliente", "NomeCliente", "Celular", "NomeCidade", "razaoSocial", "idCartao", "DtSolicCadastro", "DtAtivacaoCartao", "LimiteDeCompras", "SaldoUtilizado", "StatusCadastro", "CartaoBloqueado", "ContaBloqueada"];
const GENERICO = ["id_cliente", "nome", "telefone", "cpf", "cidade", "limite_total", "valor_utilizado", "saldo_disponivel", "status_conta", "autorizacao_comunicacao"];

describe("detectFormat", () => {
  it("reconhece cada formato pelos cabeçalhos reais", () => {
    expect(detectFormat(COMPRAS)).toBe("compras");
    expect(detectFormat(CARTOES)).toBe("cartoes");
    expect(detectFormat(GENERICO)).toBe("generico");
  });

  it("ignora acento, caixa e separadores", () => {
    expect(detectFormat(["Id_Transação_Cartão", "Valor Principal", "dt_confirmada"])).toBe("compras");
    expect(detectFormat(["Limite de Compras", "Saldo Utilizado", "Id Cartão"])).toBe("cartoes");
  });

  it("não chuta quando não dá para saber", () => {
    expect(detectFormat(["coluna a", "coluna b"])).toBe("desconhecido");
    expect(detectFormat(["nome", "telefone", "cpf"])).toBe("desconhecido");
    expect(detectFormat([])).toBe("desconhecido");
  });
});

describe("formatMismatch", () => {
  it("o erro do incidente: compras importadas como cartões e contas", () => {
    const r = formatMismatch("cartoes", COMPRAS);
    expect(r?.detectado).toBe("compras");
    expect(r?.mensagem).toContain("Compras");
    expect(r?.mensagem).toContain("Cartões e contas");
  });
  it("formato certo ou arquivo desconhecido não bloqueia", () => {
    expect(formatMismatch("cartoes", CARTOES)).toBeNull();
    expect(formatMismatch("compras", COMPRAS)).toBeNull();
    expect(formatMismatch("cartoes", ["a", "b"])).toBeNull();
  });
  it("cartões importado como compras também é barrado", () => {
    expect(formatMismatch("compras", CARTOES)?.detectado).toBe("cartoes");
  });
});
