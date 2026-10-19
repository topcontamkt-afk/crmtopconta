/**
 * Trabalho que segue depois da resposta (ex.: a auditoria de um 403). No Worker, a promessa que não for
 * entregue ao `waitUntil` é cancelada quando a resposta sai; a entrada do Worker registra o `waitUntil`
 * (configureBackground). No Node (servidor local, testes) não há o que registrar: a promessa segue sozinha.
 * Erro nunca vira exceção sem tratamento: vai para o log com o rótulo.
 */
type WaitUntil = (promise: Promise<unknown>) => void;

let waitUntil: WaitUntil | undefined;

export function configureBackground(fn: WaitUntil): void {
  waitUntil = fn;
}

export function background(rotulo: string, promise: Promise<unknown>): void {
  const segura = promise.catch((e) => console.error(`[background] ${rotulo}:`, e));
  waitUntil?.(segura);
}
