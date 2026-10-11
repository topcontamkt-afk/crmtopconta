// Contexto de renderização das mensagens (puro: sem banco), usado no envio e nos testes.

export const brl = (n: unknown) => Number(n ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Contexto de renderização de um cliente real (usado no envio). */
export function templateContext(client: {
  nome: string;
  cidade: string | null;
  percentualUtilizado: unknown;
  saldoDisponivel: unknown;
  limiteTotal: unknown;
}): Record<string, unknown> {
  return {
    nome: client.nome,
    cidade: client.cidade,
    percentual: client.percentualUtilizado,
    saldo: brl(client.saldoDisponivel),
    limite: brl(client.limiteTotal),
    limite_disponivel: brl(client.saldoDisponivel),
  };
}

/**
 * Contexto de um destinatário de campanha manual: nome e limite disponível vêm da planilha; cidade,
 * percentual e limite total só existem se o contato for cliente da base. Sem o limite da planilha,
 * `saldo`/`limite_disponivel` ficam vazios (o envio é bloqueado se o texto usa essas variáveis).
 */
export function recipientContext(
  recipient: { nome: string; limiteDisponivel: unknown },
  client: { cidade: string | null; percentualUtilizado: unknown; limiteTotal: unknown } | null
): Record<string, unknown> {
  const disponivel = recipient.limiteDisponivel === null || recipient.limiteDisponivel === undefined ? "" : brl(recipient.limiteDisponivel);
  return {
    nome: recipient.nome,
    cidade: client?.cidade ?? "",
    percentual: client?.percentualUtilizado ?? "",
    saldo: disponivel,
    limite: client ? brl(client.limiteTotal) : "",
    limite_disponivel: disponivel,
  };
}

/** O texto usa alguma variável de limite disponível? */
export function usesLimiteDisponivel(text: string): boolean {
  return /\{\{\s*(saldo|limite_disponivel)\s*\}\}/.test(text);
}

export function renderTemplate(template: string, client: Record<string, any>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = client[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

