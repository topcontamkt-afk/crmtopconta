import { INSTRUCOES_ASSISTENTE } from "./instrucoes";
import { ContextoFerramenta, executarFerramenta, FERRAMENTAS } from "./ferramentas";
import { DefinicaoFerramenta, NomeProvedor, ProvedorIA, Turno } from "./provedores/tipos";

/**
 * Laço do assistente: pergunta -> o modelo escolhe ferramentas de leitura -> o servidor as executa no tenant de quem
 * perguntou -> o modelo responde com o que voltou. Funciona igual para qualquer provedor (Claude ou GPT): o `ProvedorIA` só
 * traduz a conversa. O histórico é só ANEXADO. Nenhuma ferramenta escreve, envia ou projeta (ver ferramentas.ts).
 */

export const MAX_PASSOS = 6;

export interface MensagemEntrada {
  role: "user" | "assistant";
  content: string;
}

export interface ChamadaFerramenta {
  nome: string;
  entrada: unknown;
  ok: boolean;
}

export type FimDaResposta = "completo" | "limite_de_passos" | "recusa" | "truncada";

export interface RespostaAssistente {
  resposta: string;
  ferramentas: ChamadaFerramenta[];
  uso: { entrada: number; saida: number; cacheLeitura: number };
  provedor: NomeProvedor;
  modelo: string;
  fim: FimDaResposta;
  avisos: string[];
}

export const DEFINICOES: DefinicaoFerramenta[] = FERRAMENTAS.map((f) => ({ nome: f.nome, descricao: f.descricao, esquema: f.inputSchema }));

export async function responder(params: { mensagens: MensagemEntrada[]; ctx: ContextoFerramenta; provedor: ProvedorIA; modelo: string }): Promise<RespostaAssistente> {
  const { ctx, provedor, modelo } = params;
  const turnos: Turno[] = params.mensagens.map((m) => (m.role === "user" ? { tipo: "usuario", texto: m.content } : { tipo: "assistente", texto: m.content, chamadas: [] }));
  const chamadas: ChamadaFerramenta[] = [];
  const uso = { entrada: 0, saida: 0, cacheLeitura: 0 };
  const avisos: string[] = [];

  const montar = (resposta: string, fim: FimDaResposta): RespostaAssistente => {
    const falhas = chamadas.filter((c) => !c.ok).length;
    if (falhas > 0) avisos.push(`${falhas} consulta(s) não puderam ser feitas; a resposta pode estar incompleta.`);
    if (fim === "truncada") avisos.push("A resposta foi cortada por tamanho. Peça um recorte menor.");
    if (fim === "limite_de_passos") avisos.push("Foram necessárias muitas consultas; a resposta usa só o que foi reunido até aqui.");
    return { resposta, ferramentas: chamadas, uso, provedor: provedor.nome, modelo, fim, avisos };
  };

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    const ultimo = passo === MAX_PASSOS - 1;
    const r = await provedor.responder({ modelo, sistema: INSTRUCOES_ASSISTENTE, ferramentas: DEFINICOES, turnos, ultimoPasso: ultimo });
    uso.entrada += r.uso.entrada;
    uso.saida += r.uso.saida;
    uso.cacheLeitura += r.uso.cacheLeitura;

    if (r.parou === "recusa") return montar("Não posso responder a este pedido.", "recusa");

    // Anexa a resposta INTEIRA (o provedor guarda o bruto): o histórico nunca é editado.
    turnos.push({ tipo: "assistente", texto: r.texto, chamadas: r.chamadas, bruto: r.bruto });

    if (r.parou !== "ferramentas") {
      const fim: FimDaResposta = r.parou === "truncada" ? "truncada" : "completo";
      return montar(r.texto || "Não consegui montar uma resposta com os dados disponíveis.", fim);
    }

    const resultados = await Promise.all(r.chamadas.map((c) => executarFerramenta(c.nome, c.entrada, ctx)));
    r.chamadas.forEach((c, i) => chamadas.push({ nome: c.nome, entrada: c.entrada, ok: resultados[i].ok }));
    turnos.push({ tipo: "resultados", itens: r.chamadas.map((c, i) => ({ id: c.id, conteudo: resultados[i].conteudo, erro: !resultados[i].ok })) });
  }

  return montar("Não consegui concluir a consulta. Tente uma pergunta mais específica.", "limite_de_passos");
}
