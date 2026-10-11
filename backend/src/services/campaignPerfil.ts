import { EventEvaluation, liftAtDay, statsAtDay } from "./campaignResults";
import { PerfilRenda, PERFIS_RENDA } from "./rendaPerfil";

/**
 * Resultado da campanha quebrado por perfil de renda (PF1–PF4). O perfil vem do limite ATUAL do
 * cliente (o limite quase não muda, mas não é a foto do dia do envio). Clientes sem perfil
 * (limite zero) caem em `semPerfil`. O controle é comparado dentro do mesmo perfil.
 */
export interface PerfilResultado {
  perfil: PerfilRenda | "SEM_PERFIL";
  enviados: number;
  convertidos: number;
  taxa: number; // 0-1
  lucro: number;
  valorMovimentado: number;
  controle: number; // tamanho do controle no perfil
  taxaControle: number | null;
  liftPontos: number | null;
  significativo95: boolean | null;
}

export function breakdownByPerfil(
  treated: EventEvaluation[],
  control: EventEvaluation[],
  perfilOf: (clientId: string) => PerfilRenda | null,
  dia: number
): PerfilResultado[] {
  const keys: Array<PerfilRenda | "SEM_PERFIL"> = [...PERFIS_RENDA, "SEM_PERFIL"];
  const of = (e: EventEvaluation) => perfilOf(e.clientId) ?? "SEM_PERFIL";
  return keys
    .map((perfil) => {
      const t = treated.filter((e) => of(e) === perfil);
      const c = control.filter((e) => of(e) === perfil);
      const st = statsAtDay(t, dia);
      const lift = c.length > 0 && t.length > 0 ? liftAtDay(t, c, dia) : null;
      return {
        perfil,
        enviados: st.n,
        convertidos: st.convertidos,
        taxa: st.taxa,
        lucro: st.lucro,
        valorMovimentado: st.valorMovimentado,
        controle: c.length,
        taxaControle: lift ? lift.taxaControle : null,
        liftPontos: lift && !lift.dadosInsuficientes ? lift.liftPontos : null,
        significativo95: lift ? lift.significativo95 : null,
      };
    })
    .filter((r) => r.enviados > 0 || r.controle > 0);
}
