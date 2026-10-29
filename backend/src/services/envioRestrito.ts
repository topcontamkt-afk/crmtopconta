import { canonicalPhone } from "./privacy";

/**
 * Homologação só envia de verdade para números de teste. A conta da Meta da homologação tem credencial real (o
 * `MESSAGING_MODE=mock` só vale quando NÃO há canal do tenant), então sem esta trava uma campanha de teste atinge
 * clientes reais (incidente de 22/10/2026). Ativa com `APP_ENV=hml`; os números vêm de `ENVIO_PERMITIDO_PARA`
 * (separados por vírgula ou ponto e vírgula; qualquer formatação do número). Lista vazia = nenhum envio real. Produção e local não são afetados.
 * O valor `*` LIBERA a homologação para qualquer número (decisão explícita de quem opera, 29/10/2026): as demais travas de envio
 * (base legal, opt-out, limite, dedupe por telefone, lock por empresa, janela de 24h) continuam valendo. Para voltar a travar,
 * troque `*` por uma lista de números (ou por vazio).
 */
export interface RestricaoEnvio {
  ativa: boolean;
  permitidos: Set<string>;
}

export const MOTIVO_FORA_DA_LISTA = "Homologação: o número não está na lista de teste (ENVIO_PERMITIDO_PARA). Nada foi enviado.";

export function restricaoDeEnvio(env: NodeJS.ProcessEnv = process.env): RestricaoEnvio {
  const permitidos = new Set<string>();
  let liberado = false;
  for (const n of String(env.ENVIO_PERMITIDO_PARA ?? "").split(/[,;\n]+/)) {
    if (n.trim() === "*") { liberado = true; continue; }
    const c = canonicalPhone(n);
    if (c) permitidos.add(c);
  }
  return { ativa: env.APP_ENV === "hml" && !liberado, permitidos };
}

/** Motivo do bloqueio, ou null quando o envio é permitido. */
export function bloqueioPorRestricao(r: RestricaoEnvio, telefone: string | null | undefined): string | null {
  if (!r.ativa) return null;
  const c = canonicalPhone(telefone);
  return c && r.permitidos.has(c) ? null : MOTIVO_FORA_DA_LISTA;
}
