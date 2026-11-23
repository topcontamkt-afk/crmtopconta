/**
 * Camada de provedores de IA do assistente. O laço (assistente.ts), as ferramentas, os filtros de projeção/dados pessoais e as
 * instruções NÃO dependem do modelo: cada provedor só traduz a conversa neutra abaixo para o formato da sua API e de volta.
 */

export type NomeProvedor = "anthropic" | "openai";
export const PROVEDORES: NomeProvedor[] = ["anthropic", "openai"];
export const ROTULO_PROVEDOR: Record<NomeProvedor, string> = { anthropic: "Claude (Anthropic)", openai: "GPT (OpenAI)" };

export interface DefinicaoFerramenta {
  nome: string;
  descricao: string;
  esquema: Record<string, unknown>;
}

export interface ChamadaModelo {
  id: string;
  nome: string;
  entrada: unknown;
}

export interface ResultadoChamada {
  id: string;
  conteudo: string;
  erro: boolean;
}

/** Conversa neutra. O histórico só é ANEXADO; `bruto` guarda a resposta original do provedor para reenviá-la intacta. */
export type Turno =
  | { tipo: "usuario"; texto: string }
  | { tipo: "assistente"; texto: string; chamadas: ChamadaModelo[]; bruto?: unknown }
  | { tipo: "resultados"; itens: ResultadoChamada[] };

export type MotivoParada = "fim" | "ferramentas" | "recusa" | "truncada";

export interface RespostaModelo {
  texto: string;
  chamadas: ChamadaModelo[];
  parou: MotivoParada;
  bruto?: unknown;
  uso: { entrada: number; saida: number; cacheLeitura: number };
}

export interface PedidoModelo {
  modelo: string;
  sistema: string;
  ferramentas: DefinicaoFerramenta[];
  turnos: Turno[];
  /** No último passo permitido o modelo não pode pedir ferramentas: tem de responder com o que já reuniu. */
  ultimoPasso: boolean;
}

export interface ProvedorIA {
  nome: NomeProvedor;
  responder(pedido: PedidoModelo): Promise<RespostaModelo>;
}

export type CodigoErroProvedor = "CHAVE_RECUSADA" | "LIMITE_PROVEDOR" | "TEMPO_ESGOTADO" | "MODELO_INVALIDO" | "FALHA_PROVEDOR";

/** Erro já traduzido, igual para qualquer provedor (a rota mapeia o código para a resposta HTTP). */
export class ErroProvedor extends Error {
  constructor(public codigo: CodigoErroProvedor, mensagem: string, public status?: number) {
    super(mensagem);
    this.name = "ErroProvedor";
  }
}

export function erroPorStatus(status: number, detalhe: string): ErroProvedor {
  if (status === 401 || status === 403) return new ErroProvedor("CHAVE_RECUSADA", detalhe, status);
  if (status === 429) return new ErroProvedor("LIMITE_PROVEDOR", detalhe, status);
  if (status === 404) return new ErroProvedor("MODELO_INVALIDO", detalhe, status);
  return new ErroProvedor("FALHA_PROVEDOR", detalhe, status);
}
