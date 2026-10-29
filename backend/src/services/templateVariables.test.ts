import { comRodape, INSTRUCAO_OPT_OUT, mencionaOptOut, montarRodape, nomeControlador } from "./templateVariables";
import { baseLegalVigente, liaPendente, motivoSemBaseLegal, SEM_BASE_LEGAL } from "./baseLegal";

describe("LGPD 02-05: rodapé do controlador (montarRodape)", () => {
  it("padrão: nome do controlador (ou do tenant) + Responda SAIR", () => {
    expect(montarRodape({ name: "TopConta" })).toBe(`TopConta: ${INSTRUCAO_OPT_OUT}`);
    expect(montarRodape({ name: "TopConta", controladorNome: "Top Conta Pagamentos Ltda" })).toBe(`Top Conta Pagamentos Ltda: ${INSTRUCAO_OPT_OUT}`);
    expect(nomeControlador({ name: "X", controladorNome: "   " })).toBe("X");
  });

  it("rodapé próprio: usado como está quando já identifica e ensina a parar", () => {
    expect(montarRodape({ name: "TopConta", rodapeOptOut: "TopConta. Para sair, responda PARAR." })).toBe("TopConta. Para sair, responda PARAR.");
  });

  it("rodapé próprio sem o nome ganha o nome; sem instrução de saída ganha a instrução padrão", () => {
    expect(montarRodape({ name: "TopConta", rodapeOptOut: "Responda SAIR para sair." })).toBe("TopConta: Responda SAIR para sair.");
    expect(montarRodape({ name: "TopConta", rodapeOptOut: "TopConta, cartão de benefícios." })).toBe(`TopConta, cartão de benefícios. ${INSTRUCAO_OPT_OUT}`);
  });

  it("comRodape acrescenta uma vez só", () => {
    const r = montarRodape({ name: "TopConta" });
    const uma = comRodape("Olá Ana!", r);
    expect(uma).toBe(`Olá Ana!\n\n${r}`);
    expect(comRodape(uma, r)).toBe(uma);
  });

  it("mencionaOptOut reconhece as palavras de saída, com ou sem acento e maiúsculas", () => {
    for (const t of ["Responda SAIR", "Para parar, envie PARAR", "STOP", "Quero me descadastrar"]) expect(mencionaOptOut(t)).toBe(true);
    for (const t of ["Seu limite renovou", "Saiba mais", null, ""]) expect(mencionaOptOut(t)).toBe(false);
  });
});

describe("LGPD 02-01: base legal do tenant", () => {
  it("só as duas bases declaradas liberam o envio", () => {
    expect(motivoSemBaseLegal({ baseLegalMarketing: null })).toBe(SEM_BASE_LEGAL);
    expect(motivoSemBaseLegal({ baseLegalMarketing: "OUTRA" })).toBe(SEM_BASE_LEGAL);
    expect(motivoSemBaseLegal(null)).toBe(SEM_BASE_LEGAL);
    expect(motivoSemBaseLegal({ baseLegalMarketing: "LEGITIMO_INTERESSE" })).toBeNull();
    expect(baseLegalVigente({ baseLegalMarketing: "CONSENTIMENTO" })).toBe("CONSENTIMENTO");
  });

  it("legítimo interesse sem versão e data da LIA fica pendente", () => {
    expect(liaPendente({ baseLegalMarketing: "LEGITIMO_INTERESSE" })).toBe(true);
    expect(liaPendente({ baseLegalMarketing: "LEGITIMO_INTERESSE", liaVersao: "v1" })).toBe(true);
    expect(liaPendente({ baseLegalMarketing: "LEGITIMO_INTERESSE", liaVersao: "v1", liaAprovadaEm: new Date() })).toBe(false);
    expect(liaPendente({ baseLegalMarketing: "CONSENTIMENTO" })).toBe(false);
  });
});
