import { api, ApiError } from "../api/client";

/** Mensagens por chamada ao servidor (o servidor também limita a 25). */
export const LOTE_DISPARO = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ResultadoDisparo {
  /** acabou a fila */
  concluida: boolean;
  /** motivo da parada, quando não concluiu e não foi o usuário que parou */
  aviso?: string;
}

/**
 * Envia a fila de uma campanha em lotes, um de cada vez, até acabar, o usuário parar ou algo impedir. Quem chama
 * mostra o andamento (`onRestam`) e decide quando parar (`deveParar`). Nunca dispara dois lotes ao mesmo tempo: o
 * servidor também recusa (409) um segundo disparo da empresa enquanto há um em andamento.
 */
export async function executarDisparo(id: string, opcoes: { onRestam: (restam: number, fase: string) => void; deveParar: () => boolean }): Promise<ResultadoDisparo> {
  let semProgresso = 0;
  for (let guarda = 0; guarda < 2000; guarda++) {
    if (opcoes.deveParar()) return { concluida: false };
    let r: { processed: number; remaining: number; throttled?: boolean; bloqueado?: string; parcial?: string | null };
    try {
      r = await api(`/campaigns/${id}/dispatch`, { method: "POST", body: { limit: LOTE_DISPARO } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // outro disparo em andamento (outra aba): espera, sem enviar nada
        opcoes.onRestam(-1, "Outro disparo em andamento… aguardando");
        await sleep(4000);
        continue;
      }
      throw e;
    }
    if (r.bloqueado) return { concluida: false, aviso: r.bloqueado };
    opcoes.onRestam(r.remaining, r.throttled ? "Aguardando o limite de envios por minuto…" : "Enviando…");
    if (r.remaining === 0) return { concluida: true };
    if (r.throttled) {
      await sleep(8000);
    } else if (r.processed === 0 && !r.parcial) {
      // nada saiu e nada explica: não insiste para sempre
      if (++semProgresso >= 5) return { concluida: false, aviso: "O envio parou sem avançar. Veja o status das mensagens abaixo e tente de novo." };
      await sleep(3000);
    } else {
      semProgresso = 0;
      if (r.parcial) await sleep(500);
    }
  }
  return { concluida: false, aviso: "O envio parou por segurança (muitas chamadas). Continue pelo botão." };
}
